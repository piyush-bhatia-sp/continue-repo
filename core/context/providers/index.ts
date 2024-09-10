import { ContextProviderName } from "../../index.js";
import { BaseContextProvider } from "../index.js";
import CodeContextProvider from "./CodeContextProvider.js";
import CurrentFileContextProvider from "./CurrentFileContextProvider.js";
import DiffContextProvider from "./DiffContextProvider.js";
import DocsContextProvider from "./DocsContextProvider.js";
import FileTreeContextProvider from "./FileTreeContextProvider.js";
import FolderContextProvider from "./FolderContextProvider.js";
import GoogleContextProvider from "./GoogleContextProvider.js";
import LocalsProvider from "./LocalsProvider.js";
import OpenFilesContextProvider from "./OpenFilesContextProvider.js";
import SearchContextProvider from "./SearchContextProvider.js";
import TerminalContextProvider from "./TerminalContextProvider.js";

/**
 * Note: We are currently omitting the following providers due to bugs:
 * - `CodeOutlineContextProvider`
 * - `CodeHighlightsContextProvider`
 *
 * See this issue for details: https://github.com/continuedev/continue/issues/1365
 */
const Providers: (typeof BaseContextProvider)[] = [
  DiffContextProvider,
  FileTreeContextProvider,
  GoogleContextProvider,
  TerminalContextProvider,
  LocalsProvider,
  OpenFilesContextProvider,
  SearchContextProvider,
  FolderContextProvider,
  DocsContextProvider,
  CodeContextProvider,
  CurrentFileContextProvider
];

export function contextProviderClassFromName(
  name: ContextProviderName,
): typeof BaseContextProvider | undefined {
  return Providers.find((cls) => cls.description.title === name);
}
