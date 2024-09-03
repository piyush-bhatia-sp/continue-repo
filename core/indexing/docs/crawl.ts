import { Octokit } from "@octokit/rest";
import cheerio from "cheerio";
import fetch from "node-fetch";
import { URL } from "node:url";

const IGNORE_PATHS_ENDING_IN = [
  "favicon.ico",
  "robots.txt",
  ".rst.txt",
  "genindex",
  "py-modindex",
  "search.html",
  "search",
  "genindex.html",
  "changelog",
  "changelog.html",
];

const markdownRegex = new RegExp(/\.(md|mdx)$/);

async function getDefaultBranch(owner: string, repo: string): Promise<string> {
  const octokit = new Octokit({ auth: undefined });

  const repoInfo = await octokit.repos.get({
    owner,
    repo,
  });

  return repoInfo.data.default_branch;
}

async function crawlGithubRepo(baseUrl: URL) {
  const octokit = new Octokit({
    auth: undefined,
  });

  const [_, owner, repo] = baseUrl.pathname.split("/");

  const branch = await getDefaultBranch(owner, repo);
  console.log("Github repo detected. Crawling", branch, "branch");

  const tree = await octokit.request(
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    {
      owner,
      repo,
      tree_sha: branch,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
      recursive: "true",
    },
  );

  const paths = tree.data.tree
    .filter(
      (file: any) =>
        file.type === "blob" && markdownRegex.test(file.path ?? ""),
    )
    .map((file: any) => baseUrl.pathname + "/tree/main/" + file.path);

  return paths;
}

function splitUrl(url: URL) {
  const baseUrl = `${url.protocol}//${url.hostname}${
    url.port ? ":" + url.port : ""
  }`;
  const basePath = url.pathname;
  return {
    baseUrl,
    basePath,
  };
}

export type PageData = {
  url: string;
  path: string;
  html: string;
};

export async function* crawlPage(
  url: URL,
  maxDepth: number = 3,
): AsyncGenerator<PageData> {
  console.log(
    `Starting crawl from: ${url.toString()} - Max Depth: ${maxDepth}`,
  );

  const { baseUrl, basePath } = splitUrl(url);
  let paths: { path: string; depth: number }[] = [{ path: basePath, depth: 0 }];

  if (url.hostname === "github.com") {
    const githubLinks = await crawlGithubRepo(url);
    const githubLinkObjects = githubLinks.map((link) => ({
      path: link,
      depth: 0,
    }));
    paths = [...paths, ...githubLinkObjects];
  }
  console.log("Crawl completed");
}
