import { RerankerName } from "../../index.js";
import { LLMReranker } from "./llm.js";

export const AllRerankers: { [key in RerankerName]: any } = {
  llm: LLMReranker,

};
