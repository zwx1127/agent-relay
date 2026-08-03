import type { Database } from "bun:sqlite";
import type { Logger } from "../domain/logger.ts";
import { BindingRepository, WorkspaceRepository } from "./repositories/workspace.ts";
import { SessionRepository, TranscriptRepository } from "./repositories/session.ts";
import { PromptRepository } from "./repositories/prompt.ts";
import { ChatUiRepository, PagedOutputRepository } from "./repositories/ui.ts";
import { TaskRepository } from "./repositories/task.ts";

export interface SQLiteRepositories {
  workspaces: WorkspaceRepository;
  bindings: BindingRepository;
  sessions: SessionRepository;
  transcripts: TranscriptRepository;
  prompts: PromptRepository;
  pagedOutputs: PagedOutputRepository;
  chatUi: ChatUiRepository;
  tasks: TaskRepository;
}

export function createSQLiteRepositories(db: Database, logger: Logger): SQLiteRepositories {
  return {
    workspaces: new WorkspaceRepository(db),
    bindings: new BindingRepository(db),
    sessions: new SessionRepository(db, logger),
    transcripts: new TranscriptRepository(db),
    prompts: new PromptRepository(db),
    pagedOutputs: new PagedOutputRepository(db),
    chatUi: new ChatUiRepository(db),
    tasks: new TaskRepository(db),
  };
}

export { BindingRepository, WorkspaceRepository } from "./repositories/workspace.ts";
export { SessionRepository, TranscriptRepository } from "./repositories/session.ts";
export { PromptRepository } from "./repositories/prompt.ts";
export { ChatUiRepository, PagedOutputRepository } from "./repositories/ui.ts";
export { TaskRepository } from "./repositories/task.ts";
