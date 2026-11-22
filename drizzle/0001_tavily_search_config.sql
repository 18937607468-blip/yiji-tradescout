CREATE TABLE `search_config` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_verification` text,
	`verification_id` text,
	`verification_started_at` text
);
