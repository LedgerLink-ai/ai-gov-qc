// Programmatic API. The MCP server (week 3) and the gate call these; they must
// never re-implement a check.
export { loadConfig, crossValidate } from './config';
export { run, type RunOptions } from './runner';
export { toSarif, toEvidence, toJson, toText, readBaseline, writeBaseline, worthShowing } from './report';
export { resolveTags } from './tags';
export { runConformance, runFixture } from './conform';
export {
  commitSource,
  directorySource,
  indexSource,
  gitDiffFiles,
  gitStagedFiles,
  gitRangeFiles,
  gitTreeFiles,
  listFiles,
} from './sources';
export { ENGINE_VERSION } from './version';
export * from './types';
