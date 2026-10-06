ALTER TABLE `workspace_invites` ADD COLUMN `target_type` VARCHAR(32) NOT NULL DEFAULT 'file';
ALTER TABLE `workspace_invites` ADD COLUMN `target_id` CHAR(36) NOT NULL DEFAULT '';

CREATE INDEX `workspace_invites_inviter_id_idx` ON `workspace_invites`(`inviter_id`);

DROP INDEX `workspace_invites_inviter_id_invitee_email_key` ON `workspace_invites`;

CREATE UNIQUE INDEX `workspace_invites_target_unique` ON `workspace_invites`(`inviter_id`, `invitee_email`, `target_type`, `target_id`);
CREATE INDEX `workspace_invites_target_type_target_id_idx` ON `workspace_invites`(`target_type`, `target_id`);
