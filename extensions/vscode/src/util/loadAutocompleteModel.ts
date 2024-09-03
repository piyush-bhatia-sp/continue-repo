import type { ILLM } from "core";
import { ConfigHandler } from "core/config/ConfigHandler";
import { GlobalContext } from "core/util/GlobalContext";
import * as vscode from "vscode";

export class TabAutocompleteModel {
  private _llm: ILLM | undefined;
  private defaultTag = "starcoder2:3b";
  private defaultTagName = "Starcoder2 3b";
  private globalContext: GlobalContext = new GlobalContext();

  private shownOllamaWarning = false;
  private shownDeepseekWarning = false;

  private configHandler: ConfigHandler;

  constructor(configHandler: ConfigHandler) {
    this.configHandler = configHandler;
  }

  clearLlm() {
    this._llm = undefined;
  }

  async getDefaultTabAutocompleteModel() {
    return undefined;
  }

  async get() {
    if (!this._llm) {
      const config = await this.configHandler.loadConfig();
      if (config.tabAutocompleteModels?.length) {
        const selected = this.globalContext.get("selectedTabAutocompleteModel");
        if (selected) {
          this._llm =
            config.tabAutocompleteModels?.find(
              (model) => model.title === selected,
            ) ?? config.tabAutocompleteModels?.[0];
        } else {
          if (config.tabAutocompleteModels[0].title) {
            this.globalContext.update(
              "selectedTabAutocompleteModel",
              config.tabAutocompleteModels[0].title,
            );
          }
          this._llm = config.tabAutocompleteModels[0];
        }
      } else {
        this._llm = await this.getDefaultTabAutocompleteModel();
      }
    }

    return this._llm;
  }
}
