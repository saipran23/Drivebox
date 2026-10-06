CREATE INDEX `user_sessions_refresh_token_hash_idx` ON `user_sessions`(`refresh_token_hash`);

CREATE INDEX `connected_accounts_user_id_status_created_at_idx` ON `connected_accounts`(`user_id`, `status`, `created_at`);

CREATE INDEX `files_user_id_status_created_at_idx` ON `files`(`user_id`, `status`, `created_at`);
CREATE INDEX `files_user_id_status_folder_id_created_at_idx` ON `files`(`user_id`, `status`, `folder_id`, `created_at`);

CREATE INDEX `file_shares_user_id_enabled_created_at_idx` ON `file_shares`(`user_id`, `enabled`, `created_at`);
CREATE INDEX `file_shares_file_id_user_id_enabled_created_at_idx` ON `file_shares`(`file_id`, `user_id`, `enabled`, `created_at`);

CREATE INDEX `folders_user_id_deleted_at_updated_at_idx` ON `folders`(`user_id`, `deleted_at`, `updated_at`);
CREATE INDEX `folders_user_id_deleted_at_parent_id_updated_at_idx` ON `folders`(`user_id`, `deleted_at`, `parent_id`, `updated_at`);
