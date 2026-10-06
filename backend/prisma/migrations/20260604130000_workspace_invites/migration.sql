CREATE TABLE `workspace_invites` (
  `id` CHAR(36) NOT NULL,
  `inviter_id` CHAR(36) NOT NULL,
  `invitee_email` VARCHAR(191) NOT NULL,
  `role` VARCHAR(32) NOT NULL DEFAULT 'viewer',
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `revoked_at` DATETIME(3) NULL,
  `accepted_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `workspace_invites_inviter_id_invitee_email_key`(`inviter_id`, `invitee_email`),
  INDEX `workspace_invites_invitee_email_idx`(`invitee_email`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `workspace_invites` ADD CONSTRAINT `workspace_invites_inviter_id_fkey` FOREIGN KEY (`inviter_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
