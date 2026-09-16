import { AnalysisError } from '../analyses/contracts.mjs';
export const fail = (code, message, status = 400) => {
  throw new AnalysisError(code, message, false, status);
};
