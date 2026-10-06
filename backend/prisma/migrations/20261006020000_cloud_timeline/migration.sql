-- AlterTable
ALTER TABLE `audit_logs` ADD COLUMN `account_id` CHAR(36) NULL,
    ADD COLUMN `category` VARCHAR(32) NOT NULL DEFAULT 'activity',
    ADD COLUMN `destination_account_id` CHAR(36) NULL,
    ADD COLUMN `provider` VARCHAR(32) NULL,
    ADD COLUMN `source_account_id` CHAR(36) NULL;

-- CreateIndex
CREATE INDEX `audit_logs_user_id_created_at_id_idx` ON `audit_logs`(`user_id`, `created_at`, `id`);

-- CreateIndex
CREATE INDEX `audit_logs_user_id_action_created_at_id_idx` ON `audit_logs`(`user_id`, `action`, `created_at`, `id`);

-- CreateIndex
CREATE INDEX `audit_logs_user_id_category_created_at_id_idx` ON `audit_logs`(`user_id`, `category`, `created_at`, `id`);

-- CreateIndex
CREATE INDEX `audit_logs_user_id_provider_created_at_id_idx` ON `audit_logs`(`user_id`, `provider`, `created_at`, `id`);

-- CreateIndex
CREATE INDEX `audit_logs_user_id_account_id_created_at_id_idx` ON `audit_logs`(`user_id`, `account_id`, `created_at`, `id`);

-- CreateIndex
CREATE INDEX `audit_logs_user_id_source_account_id_created_at_id_idx` ON `audit_logs`(`user_id`, `source_account_id`, `created_at`, `id`);

-- CreateIndex
CREATE INDEX `audit_logs_user_id_destination_account_id_created_at_id_idx` ON `audit_logs`(`user_id`, `destination_account_id`, `created_at`, `id`);


-- Preserve and normalize metadata written by the earlier JSON-string audit helper.
UPDATE audit_logs
SET metadata = CAST(JSON_UNQUOTE(metadata) AS JSON)
WHERE JSON_TYPE(metadata) = 'STRING' AND JSON_VALID(JSON_UNQUOTE(metadata));

UPDATE audit_logs a
LEFT JOIN files f ON a.entity_type = 'file' AND f.id = a.entity_id AND f.user_id = a.user_id
LEFT JOIN connected_accounts c ON a.entity_type = 'connected_account' AND c.id = a.entity_id AND c.user_id = a.user_id
SET a.category = CASE
  WHEN a.action LIKE 'DELIVERY\\_%' THEN 'delivery'
  WHEN a.action = 'FAILOVER_TRIGGERED' THEN 'failover'
  WHEN a.action IN ('PROVIDER_HEALTHY','PROVIDER_DEGRADED','PROVIDER_UNAVAILABLE','PROVIDER_RECOVERED') THEN 'health'
  WHEN a.action IN ('PROVIDER_CONNECTED','PROVIDER_DISCONNECTED','PROVIDER_UPDATED') THEN 'providers'
  WHEN a.action LIKE '%REPLICA%' THEN 'replication'
  WHEN a.action IN ('UPLOAD_FILE','FILE_UPLOADED','TRASH_FILE','FILE_DELETED','PERMANENT_DELETE_FILE','RESTORE_FILE','FILE_RENAMED','FILE_MOVED','UPDATE_FILE','MOVE_FILES','CREATE_FOLDER','UPDATE_FOLDER','DELETE_FOLDER') THEN 'files'
  ELSE 'activity' END,
  a.account_id = COALESCE(CASE WHEN CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.accountId'))) = 36 THEN JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.accountId')) END, c.id, f.connected_account_id),
  a.source_account_id = CASE WHEN CHAR_LENGTH(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.sourceAccountId')), 'null'), NULLIF(JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.failedAccountId')), 'null'), NULLIF(JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.primaryAccountId')), 'null'))) = 36 THEN COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.sourceAccountId')), 'null'), NULLIF(JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.failedAccountId')), 'null'), NULLIF(JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.primaryAccountId')), 'null')) END,
  a.destination_account_id = CASE WHEN CHAR_LENGTH(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.destinationAccountId')), 'null'), NULLIF(JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.fallbackAccountId')), 'null'))) = 36 THEN COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.destinationAccountId')), 'null'), NULLIF(JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.fallbackAccountId')), 'null')) END,
  a.provider = COALESCE(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.provider')) IN ('s3','google_drive','dropbox') THEN JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.provider')) END, CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.fallbackProvider')) IN ('s3','google_drive','dropbox') THEN JSON_UNQUOTE(JSON_EXTRACT(a.metadata,'$.fallbackProvider')) END, f.provider, c.provider);
