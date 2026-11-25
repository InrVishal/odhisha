CREATE TABLE "deployment_marker" (
	"name" varchar(64) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The app only reads it; production's deploy step writes it as the owner role.
GRANT SELECT ON "deployment_marker" TO app_runtime;
