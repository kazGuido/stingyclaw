export const STINGYCLAW_DIR = '.stingyclaw';
export const STATE_FILE = 'state.yaml';
export const BASE_DIR = '.stingyclaw/base';
export const BACKUP_DIR = '.stingyclaw/backup';
export const LOCK_FILE = '.stingyclaw/lock';
export const CUSTOM_DIR = '.stingyclaw/custom';
export const RESOLUTIONS_DIR = '.stingyclaw/resolutions';
export const SHIPPED_RESOLUTIONS_DIR = '.claude/resolutions';
export const SKILLS_SCHEMA_VERSION = '0.1.0';

// Top-level paths to include in base snapshot and upstream extraction.
// Add new entries here when new root-level directories/files need tracking.
export const BASE_INCLUDES = ['src/', 'package.json', '.env.example', 'container/'];
