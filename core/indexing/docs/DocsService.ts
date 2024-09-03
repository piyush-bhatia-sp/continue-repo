import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import lancedb, { Connection } from "vectordb";
import { ConfigHandler } from "../../config/ConfigHandler.js";
import DocsContextProvider from "../../context/providers/DocsContextProvider.js";
import {
  Chunk,
  ContinueConfig,
  EmbeddingsProvider,
  IDE,
  IndexingProgressUpdate,
  SiteIndexingConfig,
} from "../../index.js";
import { FromCoreProtocol, ToCoreProtocol } from "../../protocol/index.js";
import { GlobalContext } from "../../util/GlobalContext.js";
import { IMessenger } from "../../util/messenger.js";
import {
  editConfigJson,
  getDocsSqlitePath,
  getLanceDbPath,
} from "../../util/paths.js";
import { Telemetry } from "../../util/posthog.js";
import TransformersJsEmbeddingsProvider from "../embeddings/TransformersJsEmbeddingsProvider.js";
import { Article, chunkArticle, pageToArticle } from "./article.js";
import { crawlPage } from "./crawl.js";
import { runLanceMigrations, runSqliteMigrations } from "./migrations.js";
import {
  downloadFromS3,
  getS3Filename,
  S3Buckets,
  SiteIndexingResults,
} from "./preIndexed.js";
import preIndexedDocs from "./preIndexedDocs.js";

// Purposefully lowercase because lancedb converts
export interface LanceDbDocsRow {
  title: string;
  starturl: string;
  // Chunk
  content: string;
  path: string;
  startline: number;
  endline: number;
  vector: number[];
  [key: string]: any;
}

export interface SqliteDocsRow {
  title: string;
  startUrl: string;
  favicon: string;
}

export type AddParams = {
  siteIndexingConfig: SiteIndexingConfig;
  chunks: Chunk[];
  embeddings: number[][];
  favicon?: string;
};

export default class DocsService {
  static lanceTableName = "docs";
  static sqlitebTableName = "docs";
  static preIndexedDocsEmbeddingsProvider =
    new TransformersJsEmbeddingsProvider();

  private static instance?: DocsService;
  public isInitialized: Promise<void>;
  public isSyncing: boolean = false;

  private docsIndexingQueue = new Set<string>();
  private globalContext = new GlobalContext();
  private lanceTableNamesSet = new Set<string>();

  private config!: ContinueConfig;
  private sqliteDb?: Database;

  // If we are instantiating a new DocsService from `getContextItems()`,
  // we have access to the direct config object.
  // When instantiating the DocsService from core, we have access
  // to a ConfigHandler instance.
  constructor(
    configOrHandler: ConfigHandler,
    private readonly ide: IDE,
    private readonly messenger?: IMessenger<ToCoreProtocol, FromCoreProtocol>,
  ) {
    this.isInitialized = this.init(configOrHandler);
  }

  static getSingleton() {
    return DocsService.instance;
  }

  static createSingleton(
    configOrHandler: ConfigHandler,
    ide: IDE,
    messenger?: IMessenger<ToCoreProtocol, FromCoreProtocol>,
  ) {
    const docsService = new DocsService(configOrHandler, ide, messenger);
    DocsService.instance = docsService;
    return docsService;
  }

  async isJetBrainsAndPreIndexedDocsProvider(): Promise<boolean> {
    const isJetBrains = await this.isJetBrains();

    const isPreIndexedDocsProvider =
      this.config.embeddingsProvider.id ===
      DocsService.preIndexedDocsEmbeddingsProvider.id;

    return isJetBrains && isPreIndexedDocsProvider;
  }

  /*
   * Currently, we generate and host embeddings for pre-indexed docs using transformers.js.
   * However, we don't ship transformers.js with the JetBrains extension.
   * So, we only include pre-indexed docs in the submenu for non-JetBrains IDEs.
   */
  async canUsePreindexedDocs() {
    const isJetBrains = await this.isJetBrains();
    return !isJetBrains;
  }

  async delete(startUrl: string) {
    await this.deleteFromLance(startUrl);
    await this.deleteFromSqlite(startUrl);
    this.deleteFromConfig(startUrl);

    if (this.messenger) {
      this.messenger.send("refreshSubmenuItems", undefined);
    }
  }

  async has(startUrl: string): Promise<Promise<boolean>> {
    const db = await this.getOrCreateSqliteDb();
    const title = await db.get(
      `SELECT title FROM ${DocsService.sqlitebTableName} WHERE startUrl = ?`,
      startUrl,
    );

    return !!title;
  }

  async indexAllDocs(reIndex: boolean = false) {
    if (!this.hasDocsContextProvider()) {
      this.ide.infoPopup(
        "No 'docs' provider configured under 'contextProviders' in config.json",
      );
      return;
    }

    const docs = await this.list();

    for (const doc of docs) {
      const generator = this.indexAndAdd(doc, reIndex);
      while (!(await generator.next()).done) {}
    }

    this.ide.infoPopup("Docs indexing completed");
  }

  async list() {
    const db = await this.getOrCreateSqliteDb();
    const docs = await db.all<SqliteDocsRow[]>(
      `SELECT title, startUrl, favicon FROM ${DocsService.sqlitebTableName}`,
    );

    return docs;
  }

  async *indexAndAdd(
    siteIndexingConfig: SiteIndexingConfig,
    reIndex: boolean = false,
  ): AsyncGenerator<IndexingProgressUpdate> {
    const { startUrl } = siteIndexingConfig;
    const embeddingsProvider = await this.getEmbeddingsProvider();

    if (this.docsIndexingQueue.has(startUrl)) {
      console.log("Already in queue");
      return;
    }

    if (!reIndex && (await this.has(startUrl))) {
      yield {
        progress: 1,
        desc: "Already indexed",
        status: "done",
      };
      return;
    }

    // Mark the site as currently being indexed
    this.docsIndexingQueue.add(startUrl);

    yield {
      progress: 0,
      desc: "Finding subpages",
      status: "indexing",
    };

    const articles: Article[] = [];
    let processedPages = 0;
    let maxKnownPages = 1;

    // Crawl pages and retrieve info as articles
    for await (const page of crawlPage(
      new URL(startUrl),
      siteIndexingConfig.maxDepth,
    )) {
      processedPages++;

      const article = pageToArticle(page);

      if (!article) {
        continue;
      }

      articles.push(article);

      // Use a heuristic approach for progress calculation
      const progress = Math.min(processedPages / maxKnownPages, 1);

      yield {
        progress, // Yield the heuristic progress
        desc: `Finding subpages (${page.path})`,
        status: "indexing",
      };

      // Increase maxKnownPages to delay progress reaching 100% too soon
      if (processedPages === maxKnownPages) {
        maxKnownPages *= 2;
      }
    }

    const chunks: Chunk[] = [];
    const embeddings: number[][] = [];

    // Create embeddings of retrieved articles
    console.log(`Creating embeddings for ${articles.length} articles`);

    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      yield {
        progress: i / articles.length,
        desc: `Creating Embeddings: ${article.subpath}`,
        status: "indexing",
      };

      try {
        const chunkedArticle = chunkArticle(
          article,
          embeddingsProvider.maxChunkSize,
        );

        const chunkedArticleContents = chunkedArticle.map(
          (chunk) => chunk.content,
        );

        chunks.push(...chunkedArticle);

        const subpathEmbeddings = await embeddingsProvider.embed(
          chunkedArticleContents,
        );

        embeddings.push(...subpathEmbeddings);
      } catch (e) {
        console.warn("Error chunking article: ", e);
      }
    }

    if (embeddings.length === 0) {
      console.error(
        `No embeddings were created for site: ${siteIndexingConfig.startUrl}\n Num chunks: ${chunks.length}`,
      );

      yield {
        progress: 1,
        desc: `No embeddings were created for site: ${siteIndexingConfig.startUrl}`,
        status: "failed",
      };

      return;
    }

    // Add docs to databases
    console.log(`Adding ${embeddings.length} embeddings to db`);

    yield {
      progress: 0.5,
      desc: `Adding ${embeddings.length} embeddings to db`,
      status: "indexing",
    };

    // Clear old index if re-indexing.
    if (reIndex) {
      console.log("Deleting old embeddings");
      await this.delete(startUrl);
    }

    const favicon = await this.fetchFavicon(siteIndexingConfig);

    await this.add({
      siteIndexingConfig,
      chunks,
      embeddings,
      favicon,
    });

    this.docsIndexingQueue.delete(startUrl);

    yield {
      progress: 1,
      desc: "Done",
      status: "done",
    };

    console.log(`Successfully indexed: ${siteIndexingConfig.startUrl}`);

    if (this.messenger) {
      this.messenger.send("refreshSubmenuItems", undefined);
    }
  }

  async retrieveChunks(
    startUrl: string,
    vector: number[],
    nRetrieve: number,
    isRetry: boolean = false,
  ): Promise<Chunk[]> {
    const table = await this.getOrCreateLanceTable({
      initializationVector: vector,
      isPreIndexedDoc: !!preIndexedDocs[startUrl],
    });

    const docs: LanceDbDocsRow[] = await table
      .search(vector)
      .limit(nRetrieve)
      .where(`starturl = '${startUrl}'`)
      .execute();

    const hasIndexedDoc = await this.hasIndexedDoc(startUrl);

    if (!hasIndexedDoc && docs.length === 0) {
      const preIndexedDoc = preIndexedDocs[startUrl];

      if (isRetry || !preIndexedDoc) {
        return [];
      }

      await this.fetchAndAddPreIndexedDocEmbeddings(preIndexedDoc.title);
      return await this.retrieveChunks(startUrl, vector, nRetrieve, true);
    }

    return docs.map((doc) => ({
      digest: doc.path,
      filepath: doc.path,
      startLine: doc.startline,
      endLine: doc.endline,
      index: 0,
      content: doc.content,
      otherMetadata: {
        title: doc.title,
      },
    }));
  }

  async getEmbeddingsProvider(isPreIndexedDoc: boolean = false) {
    const canUsePreindexedDocs = await this.canUsePreindexedDocs();

    if (isPreIndexedDoc && canUsePreindexedDocs) {
      return DocsService.preIndexedDocsEmbeddingsProvider;
    }

    return this.config.embeddingsProvider;
  }

  async getFavicon(startUrl: string) {
    const db = await this.getOrCreateSqliteDb();
    const { favicon } = await db.get(
      `SELECT favicon FROM ${DocsService.sqlitebTableName} WHERE startUrl = ?`,
      startUrl,
    );

    return favicon;
  }

  /**
   * A ConfigHandler is passed to the DocsService in `core` when
   * we don't yet have access to the config object. This handler
   * is used to set up a single instance of the DocsService that
   * subscribes to config updates, e.g. to trigger re-indexing
   * on a new embeddings provider.
   */
  private async init(configHandler: ConfigHandler) {
    if (configHandler instanceof ConfigHandler) {
      this.config = await configHandler.loadConfig();
    } else {
      this.config = configHandler;
    }

    const embeddingsProvider = await this.getEmbeddingsProvider();

    this.globalContext.update("curEmbeddingsProviderId", embeddingsProvider.id);

    configHandler.onConfigUpdate(async (newConfig) => {
      const oldConfig = this.config;

      // Need to update class property for config at the beginning of this callback
      // to ensure downstream methods have access to the latest config.
      this.config = newConfig;

      if (oldConfig.docs !== newConfig.docs) {
        await this.syncConfigAndSqlite();
      }

      const shouldReindex = await this.shouldReindexDocsOnNewEmbeddingsProvider(
        newConfig.embeddingsProvider.id,
      );

      if (shouldReindex) {
        await this.reindexDocsOnNewEmbeddingsProvider(
          newConfig.embeddingsProvider,
        );
      }
    });
  }

  private async syncConfigAndSqlite() {
    this.isSyncing = true;

    const sqliteDocs = await this.list();
    const sqliteDocStartUrls = sqliteDocs.map((doc) => doc.startUrl) || [];

    const configDocs = this.config.docs || [];
    const configDocStartUrls =
      this.config.docs?.map((doc) => doc.startUrl) || [];

    const newDocs = configDocs.filter(
      (doc) => !sqliteDocStartUrls.includes(doc.startUrl),
    );
    const deletedDocs = sqliteDocs.filter(
      (doc) =>
        !configDocStartUrls.includes(doc.startUrl) &&
        !preIndexedDocs[doc.startUrl],
    );

    for (const doc of newDocs) {
      console.log(`Indexing new doc: ${doc.startUrl}`);
      Telemetry.capture("add_docs_config", { url: doc.startUrl });

      const generator = this.indexAndAdd(doc);
      while (!(await generator.next()).done) {}
    }

    for (const doc of deletedDocs) {
      console.log(`Deleting doc: ${doc.startUrl}`);
      await this.delete(doc.startUrl);
    }

    this.isSyncing = false;
  }

  private hasDocsContextProvider() {
    return !!this.config.contextProviders?.some(
      (provider) =>
        provider.description.title === DocsContextProvider.description.title,
    );
  }

  private async getOrCreateSqliteDb() {
    if (!this.sqliteDb) {
      const db = await open({
        filename: getDocsSqlitePath(),
        driver: sqlite3.Database,
      });

      await runSqliteMigrations(db);

      await db.exec(`CREATE TABLE IF NOT EXISTS ${DocsService.sqlitebTableName} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title STRING NOT NULL,
            startUrl STRING NOT NULL UNIQUE,
            favicon STRING
        )`);

      this.sqliteDb = db;
    }

    return this.sqliteDb;
  }

  private async createLanceDocsTable(
    connection: Connection,
    initializationVector: number[],
    tableName: string,
  ) {
    const mockRowTitle = "mockRowTitle";
    const mockRow: LanceDbDocsRow[] = [
      {
        title: mockRowTitle,
        vector: initializationVector,
        starturl: "",
        content: "",
        path: "",
        startline: 0,
        endline: 0,
      },
    ];

    const table = await connection.createTable(tableName, mockRow);

    await runLanceMigrations(table);

    await table.delete(`title = '${mockRowTitle}'`);
  }

  private removeInvalidLanceTableNameChars(tableName: string) {
    return tableName.replace(/:/g, "");
  }

  private async getLanceTableNameFromEmbeddingsProvider(
    isPreIndexedDoc: boolean,
  ) {
    const embeddingsProvider =
      await this.getEmbeddingsProvider(isPreIndexedDoc);
    const embeddingsProviderId = this.removeInvalidLanceTableNameChars(
      embeddingsProvider.id,
    );
    const tableName = `${DocsService.lanceTableName}${embeddingsProviderId}`;

    return tableName;
  }

  private async getOrCreateLanceTable({
    initializationVector,
    isPreIndexedDoc,
  }: {
    initializationVector: number[];
    isPreIndexedDoc?: boolean;
  }) {
    const conn = await lancedb.connect(getLanceDbPath());
    const tableNames = await conn.tableNames();
    const tableNameFromEmbeddingsProvider =
      await this.getLanceTableNameFromEmbeddingsProvider(!!isPreIndexedDoc);

    if (!tableNames.includes(tableNameFromEmbeddingsProvider)) {
      if (initializationVector) {
        await this.createLanceDocsTable(
          conn,
          initializationVector,
          tableNameFromEmbeddingsProvider,
        );
      } else {
        console.trace(
          "No existing Lance DB docs table was found and no initialization " +
            "vector was passed to create one",
        );
      }
    }

    const table = await conn.openTable(tableNameFromEmbeddingsProvider);

    this.lanceTableNamesSet.add(tableNameFromEmbeddingsProvider);

    return table;
  }

  private async isJetBrains() {
    const ideInfo = await this.ide.getIdeInfo();
    return ideInfo.ideType === "jetbrains";
  }

  private async hasIndexedDoc(startUrl: string) {
    const db = await this.getOrCreateSqliteDb();
    const docs = await db.all(
      `SELECT startUrl FROM ${DocsService.sqlitebTableName} WHERE startUrl = ?`,
      startUrl,
    );

    return docs.length > 0;
  }

  private async addToLance({
    chunks,
    siteIndexingConfig,
    embeddings,
  }: AddParams) {
    const sampleVector = embeddings[0];
    const isPreIndexedDoc = !!preIndexedDocs[siteIndexingConfig.startUrl];
    const table = await this.getOrCreateLanceTable({
      isPreIndexedDoc,
      initializationVector: sampleVector,
    });

    const rows: LanceDbDocsRow[] = chunks.map((chunk, i) => ({
      vector: embeddings[i],
      starturl: siteIndexingConfig.startUrl,
      title: chunk.otherMetadata?.title || siteIndexingConfig.title,
      content: chunk.content,
      path: chunk.filepath,
      startline: chunk.startLine,
      endline: chunk.endLine,
    }));

    await table.add(rows);
  }

  private async addToSqlite({
    siteIndexingConfig: { title, startUrl },
    favicon,
  }: AddParams) {
    const db = await this.getOrCreateSqliteDb();
    await db.run(
      `INSERT INTO ${DocsService.sqlitebTableName} (title, startUrl, favicon) VALUES (?, ?, ?)`,
      title,
      startUrl,
      favicon,
    );
  }

  private addToConfig({ siteIndexingConfig }: AddParams) {
    // Handles the case where a user has manually added the doc to config.json
    // so it already exists in the file
    const doesDocExist = this.config.docs?.some(
      (doc) => doc.startUrl === siteIndexingConfig.startUrl,
    );

    if (!doesDocExist) {
      editConfigJson((config) => ({
        ...config,
        docs: [...(config.docs ?? []), siteIndexingConfig],
      }));
    }
  }

  private async add(params: AddParams) {
    await this.addToLance(params);
    await this.addToSqlite(params);

    const isPreIndexedDoc =
      !!preIndexedDocs[params.siteIndexingConfig.startUrl];

    if (!isPreIndexedDoc) {
      this.addToConfig(params);
    }
  }

  private async deleteFromLance(startUrl: string) {
    for (const tableName of this.lanceTableNamesSet) {
      const conn = await lancedb.connect(getLanceDbPath());
      const table = await conn.openTable(tableName);
      await table.delete(`starturl = '${startUrl}'`);
    }
  }

  private async deleteFromSqlite(startUrl: string) {
    const db = await this.getOrCreateSqliteDb();
    await db.run(
      `DELETE FROM ${DocsService.sqlitebTableName} WHERE startUrl = ?`,
      startUrl,
    );
  }

  deleteFromConfig(startUrl: string) {
    editConfigJson((config) => ({
      ...config,
      docs: config.docs?.filter((doc) => doc.startUrl !== startUrl) || [],
    }));
  }

  private async fetchAndAddPreIndexedDocEmbeddings(title: string) {
    const embeddingsProvider = await this.getEmbeddingsProvider(true);

    const data = await downloadFromS3(
      S3Buckets.continueIndexedDocs,
      getS3Filename(embeddingsProvider.id, title),
    );

    const siteEmbeddings = JSON.parse(data) as SiteIndexingResults;
    const startUrl = new URL(siteEmbeddings.url).toString();
    const favicon = await this.fetchFavicon(preIndexedDocs[startUrl]);

    await this.add({
      favicon,
      siteIndexingConfig: {
        startUrl,
        title: siteEmbeddings.title,
      },
      chunks: siteEmbeddings.chunks,
      embeddings: siteEmbeddings.chunks.map((c) => c.embedding),
    });
  }

  private async fetchFavicon(siteIndexingConfig: SiteIndexingConfig) {
    return `data:image/x-icon;base64,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`;
  }

  private async shouldReindexDocsOnNewEmbeddingsProvider(
    curEmbeddingsProviderId: EmbeddingsProvider["id"],
  ): Promise<boolean> {
    const isJetBrainsAndPreIndexedDocsProvider =
      await this.isJetBrainsAndPreIndexedDocsProvider();

    if (isJetBrainsAndPreIndexedDocsProvider) {
      this.ide.errorPopup(
        "The 'transformers.js' embeddings provider currently cannot be used to index " +
          "documentation in JetBrains. To enable documentation indexing, you can use " +
          "any of the other providers described in the docs: " +
          "https://docs.continue.dev/walkthroughs/codebase-embeddings#embeddings-providers",
      );

      this.globalContext.update(
        "curEmbeddingsProviderId",
        curEmbeddingsProviderId,
      );

      return false;
    }

    const lastEmbeddingsProviderId = this.globalContext.get(
      "curEmbeddingsProviderId",
    );

    if (!lastEmbeddingsProviderId) {
      // If it's the first time we're setting the `curEmbeddingsProviderId`
      // global state, we don't need to reindex docs
      this.globalContext.update(
        "curEmbeddingsProviderId",
        curEmbeddingsProviderId,
      );

      return false;
    }

    return lastEmbeddingsProviderId !== curEmbeddingsProviderId;
  }

  /**
   * Currently this deletes re-crawls + re-indexes all docs.
   * A more optimal solution in the future will be to create
   * a per-embeddings-provider table for docs.
   */
  private async reindexDocsOnNewEmbeddingsProvider(
    embeddingsProvider: EmbeddingsProvider,
  ) {
    // We use config as our source of truth here since it contains additional information
    // needed for re-crawling such as `faviconUrl` and `maxDepth`.
    const { docs } = this.config;

    if (!docs || docs.length === 0) {
      return;
    }

    console.log(
      `Reindexing docs with new embeddings provider: ${embeddingsProvider.id}`,
    );

    for (const doc of docs) {
      await this.delete(doc.startUrl);

      const generator = this.indexAndAdd(doc);

      while (!(await generator.next()).done) {}
    }

    // Important that this only is invoked after we have successfully
    // cleared and reindex the docs so that the table cannot end up in an
    // invalid state.
    this.globalContext.update("curEmbeddingsProviderId", embeddingsProvider.id);

    console.log("Completed reindexing of all docs");
  }
}

export const docsServiceSingleton = DocsService.getSingleton();
