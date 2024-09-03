import { CONTROL_PLANE_URL } from "../../../control-plane/client.js";
import type { LLMOptions, ModelProvider } from "../../../index.js";

class ContinueProxy {
  private _workOsAccessToken: string | undefined = undefined;

  get workOsAccessToken(): string | undefined {
    return this._workOsAccessToken;
  }

  set workOsAccessToken(value: string | undefined) {
    if (this._workOsAccessToken !== value) {
      this._workOsAccessToken = value;
    }
  }
  static providerName: ModelProvider = "continue-proxy";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: new URL("/model-proxy/v1", CONTROL_PLANE_URL).toString(),
    useLegacyCompletionsEndpoint: false,
  };

  supportsCompletions(): boolean {
    return false;
  }

  supportsFim(): boolean {
    return true;
  }
}

export default ContinueProxy;
