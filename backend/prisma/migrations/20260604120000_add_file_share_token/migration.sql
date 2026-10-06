ALTER TABLE `file_shares` ADD COLUMN `token` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `file_shares_token_key` ON `file_shares`(`token`);
