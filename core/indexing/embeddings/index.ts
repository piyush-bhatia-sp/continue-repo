import { EmbeddingsProviderName } from "../../index.js";
import BaseEmbeddingsProvider from "./BaseEmbeddingsProvider.js";
import TransformersJsEmbeddingsProvider from "./TransformersJsEmbeddingsProvider.js";

type EmbeddingsProviderConstructor = new (
  ...args: any[]
) => BaseEmbeddingsProvider;

export const allEmbeddingsProviders: Record<
  EmbeddingsProviderName,
  EmbeddingsProviderConstructor
> = {
  "transformers.js": TransformersJsEmbeddingsProvider
  
};
