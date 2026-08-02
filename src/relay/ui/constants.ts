export const CALLBACK_PREFIX = "ar:";
export const CALLBACK_LIMIT_BYTES = 64;
export const STREAM_QUIET_MS = 800;
export const STREAM_MAX_MS = 3000;
export const STREAM_FLUSH_CHARS = 3400;
export const ACTIVITY_MAX_CHARS = 3000;
export const ACTIVITY_REASONING_CHARS = 300;
export const ACTIVITY_PLAN_STEPS = 6;
export const ACTIVITY_ITEM_CHARS = 160;
export const ACTIVITY_ITEMS = 5;
export const ACTIVITY_FILES = 8;
export const ACTIVITY_PATH_CHARS = 120;
export const CODEX_PROMPT_TTL_MS = 30 * 60 * 1000;
export const PAGE_MAX_CHARS = 3200;
export const PAGED_OUTPUT_TTL_MS = 24 * 60 * 60 * 1000;
export const LIST_PAGE_SIZE = 8;
export const WORKSPACE_BUTTON_LABEL_WIDTH = 40;
export const DEFAULT_IMAGE_PROMPT = "Please inspect the attached image(s).";
export const MEDIA_GROUP_QUIET_MS = 900;

export const UI_BUTTON = {
  workspace: "Workspaces",
  status: "Details",
  compact: "Compact",
  refresh: "Refresh",
  back: "Back",
  stop: "Stop",
  create: "New",
  delete: "Delete",
  approve: "Approve",
  deny: "Deny",
  firstPage: "First",
  previousPage: "Prev",
  nextPage: "Next",
  lastPage: "Last",
  selected: "Selected",
  unselected: "Select",
} as const;
