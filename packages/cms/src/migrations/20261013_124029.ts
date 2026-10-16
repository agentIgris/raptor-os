import { sql } from '@payloadcms/db-postgres'
import type { MigrateDownArgs, MigrateUpArgs } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_cms_news_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__cms_news_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum_cms_pages_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__cms_pages_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum_cms_partners_tier" AS ENUM('title', 'gold', 'silver', 'community');
  CREATE TYPE "public"."enum_cms_partners_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__cms_partners_v_version_tier" AS ENUM('title', 'gold', 'silver', 'community');
  CREATE TYPE "public"."enum__cms_partners_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum_cms_site_settings_socials_network" AS ENUM('x', 'instagram', 'youtube', 'twitch', 'discord');
  CREATE TABLE "cms_media" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"alt" varchar NOT NULL,
  	"credit" varchar,
  	"_objectkey" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"url" varchar,
  	"thumbnail_u_r_l" varchar,
  	"filename" varchar,
  	"mime_type" varchar,
  	"filesize" numeric,
  	"width" numeric,
  	"height" numeric,
  	"focal_x" numeric,
  	"focal_y" numeric,
  	"sizes_thumb_url" varchar,
  	"sizes_thumb_width" numeric,
  	"sizes_thumb_height" numeric,
  	"sizes_thumb_mime_type" varchar,
  	"sizes_thumb_filesize" numeric,
  	"sizes_thumb_filename" varchar,
  	"sizes_card_url" varchar,
  	"sizes_card_width" numeric,
  	"sizes_card_height" numeric,
  	"sizes_card_mime_type" varchar,
  	"sizes_card_filesize" numeric,
  	"sizes_card_filename" varchar,
  	"sizes_hero_url" varchar,
  	"sizes_hero_width" numeric,
  	"sizes_hero_height" numeric,
  	"sizes_hero_mime_type" varchar,
  	"sizes_hero_filesize" numeric,
  	"sizes_hero_filename" varchar
  );
  
  CREATE TABLE "cms_news" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar,
  	"slug" varchar,
  	"excerpt" varchar,
  	"body" jsonb,
  	"cover_id" integer,
  	"published_at" timestamp(3) with time zone,
  	"org_id" varchar,
  	"seo_title" varchar,
  	"seo_description" varchar,
  	"seo_image_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"_status" "enum_cms_news_status" DEFAULT 'draft'
  );
  
  CREATE TABLE "_cms_news_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"parent_id" integer,
  	"version_title" varchar,
  	"version_slug" varchar,
  	"version_excerpt" varchar,
  	"version_body" jsonb,
  	"version_cover_id" integer,
  	"version_published_at" timestamp(3) with time zone,
  	"version_org_id" varchar,
  	"version_seo_title" varchar,
  	"version_seo_description" varchar,
  	"version_seo_image_id" integer,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"version__status" "enum__cms_news_v_version_status" DEFAULT 'draft',
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"latest" boolean
  );
  
  CREATE TABLE "cms_pages_blocks_hero" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"eyebrow" varchar,
  	"heading" varchar,
  	"supporting" varchar,
  	"primary_label" varchar,
  	"primary_href" varchar,
  	"secondary_label" varchar,
  	"secondary_href" varchar,
  	"image_id" integer,
  	"block_name" varchar
  );
  
  CREATE TABLE "cms_pages_blocks_rich_text" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"body" jsonb,
  	"block_name" varchar
  );
  
  CREATE TABLE "cms_pages_blocks_media" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"image_id" integer,
  	"caption" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "cms_pages_blocks_division_spotlight" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"division_slug" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "cms_pages" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar,
  	"slug" varchar,
  	"org_id" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"_status" "enum_cms_pages_status" DEFAULT 'draft'
  );
  
  CREATE TABLE "_cms_pages_v_blocks_hero" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"eyebrow" varchar,
  	"heading" varchar,
  	"supporting" varchar,
  	"primary_label" varchar,
  	"primary_href" varchar,
  	"secondary_label" varchar,
  	"secondary_href" varchar,
  	"image_id" integer,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_cms_pages_v_blocks_rich_text" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"body" jsonb,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_cms_pages_v_blocks_media" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"image_id" integer,
  	"caption" varchar,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_cms_pages_v_blocks_division_spotlight" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"division_slug" varchar,
  	"_uuid" varchar,
  	"block_name" varchar
  );
  
  CREATE TABLE "_cms_pages_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"parent_id" integer,
  	"version_title" varchar,
  	"version_slug" varchar,
  	"version_org_id" varchar,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"version__status" "enum__cms_pages_v_version_status" DEFAULT 'draft',
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"latest" boolean
  );
  
  CREATE TABLE "cms_partners" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"logo_id" integer,
  	"url" varchar,
  	"tier" "enum_cms_partners_tier" DEFAULT 'community',
  	"agreement_ref" varchar,
  	"org_id" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"_status" "enum_cms_partners_status" DEFAULT 'draft'
  );
  
  CREATE TABLE "_cms_partners_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"parent_id" integer,
  	"version_name" varchar,
  	"version_logo_id" integer,
  	"version_url" varchar,
  	"version_tier" "enum__cms_partners_v_version_tier" DEFAULT 'community',
  	"version_agreement_ref" varchar,
  	"version_org_id" varchar,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"version__status" "enum__cms_partners_v_version_status" DEFAULT 'draft',
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"latest" boolean
  );
  
  CREATE TABLE "cms_site_settings_socials" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"network" "enum_cms_site_settings_socials_network" NOT NULL,
  	"url" varchar NOT NULL
  );
  
  CREATE TABLE "cms_site_settings" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"site_name" varchar DEFAULT 'Raptor Esports' NOT NULL,
  	"tagline" varchar,
  	"logo_id" integer,
  	"default_seo_title" varchar,
  	"default_seo_description" varchar,
  	"default_seo_image_id" integer,
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  CREATE TABLE "cms_recruitment" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"open" boolean DEFAULT false,
  	"heading" varchar,
  	"body" jsonb,
  	"form_target" varchar,
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "cms_media_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "cms_news_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "cms_pages_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "cms_partners_id" integer;
  ALTER TABLE "cms_news" ADD CONSTRAINT "cms_news_cover_id_cms_media_id_fk" FOREIGN KEY ("cover_id") REFERENCES "public"."cms_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "cms_news" ADD CONSTRAINT "cms_news_seo_image_id_cms_media_id_fk" FOREIGN KEY ("seo_image_id") REFERENCES "public"."cms_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_cms_news_v" ADD CONSTRAINT "_cms_news_v_parent_id_cms_news_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."cms_news"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_cms_news_v" ADD CONSTRAINT "_cms_news_v_version_cover_id_cms_media_id_fk" FOREIGN KEY ("version_cover_id") REFERENCES "public"."cms_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_cms_news_v" ADD CONSTRAINT "_cms_news_v_version_seo_image_id_cms_media_id_fk" FOREIGN KEY ("version_seo_image_id") REFERENCES "public"."cms_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "cms_pages_blocks_hero" ADD CONSTRAINT "cms_pages_blocks_hero_image_id_cms_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."cms_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "cms_pages_blocks_hero" ADD CONSTRAINT "cms_pages_blocks_hero_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."cms_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "cms_pages_blocks_rich_text" ADD CONSTRAINT "cms_pages_blocks_rich_text_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."cms_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "cms_pages_blocks_media" ADD CONSTRAINT "cms_pages_blocks_media_image_id_cms_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."cms_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "cms_pages_blocks_media" ADD CONSTRAINT "cms_pages_blocks_media_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."cms_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "cms_pages_blocks_division_spotlight" ADD CONSTRAINT "cms_pages_blocks_division_spotlight_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."cms_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_cms_pages_v_blocks_hero" ADD CONSTRAINT "_cms_pages_v_blocks_hero_image_id_cms_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."cms_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_cms_pages_v_blocks_hero" ADD CONSTRAINT "_cms_pages_v_blocks_hero_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_cms_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_cms_pages_v_blocks_rich_text" ADD CONSTRAINT "_cms_pages_v_blocks_rich_text_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_cms_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_cms_pages_v_blocks_media" ADD CONSTRAINT "_cms_pages_v_blocks_media_image_id_cms_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."cms_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_cms_pages_v_blocks_media" ADD CONSTRAINT "_cms_pages_v_blocks_media_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_cms_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_cms_pages_v_blocks_division_spotlight" ADD CONSTRAINT "_cms_pages_v_blocks_division_spotlight_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_cms_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_cms_pages_v" ADD CONSTRAINT "_cms_pages_v_parent_id_cms_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."cms_pages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "cms_partners" ADD CONSTRAINT "cms_partners_logo_id_cms_media_id_fk" FOREIGN KEY ("logo_id") REFERENCES "public"."cms_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_cms_partners_v" ADD CONSTRAINT "_cms_partners_v_parent_id_cms_partners_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."cms_partners"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_cms_partners_v" ADD CONSTRAINT "_cms_partners_v_version_logo_id_cms_media_id_fk" FOREIGN KEY ("version_logo_id") REFERENCES "public"."cms_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "cms_site_settings_socials" ADD CONSTRAINT "cms_site_settings_socials_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."cms_site_settings"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "cms_site_settings" ADD CONSTRAINT "cms_site_settings_logo_id_cms_media_id_fk" FOREIGN KEY ("logo_id") REFERENCES "public"."cms_media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "cms_site_settings" ADD CONSTRAINT "cms_site_settings_default_seo_image_id_cms_media_id_fk" FOREIGN KEY ("default_seo_image_id") REFERENCES "public"."cms_media"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "cms_media_updated_at_idx" ON "cms_media" USING btree ("updated_at");
  CREATE INDEX "cms_media_created_at_idx" ON "cms_media" USING btree ("created_at");
  CREATE UNIQUE INDEX "cms_media_filename_idx" ON "cms_media" USING btree ("filename");
  CREATE INDEX "cms_media_sizes_thumb_sizes_thumb_filename_idx" ON "cms_media" USING btree ("sizes_thumb_filename");
  CREATE INDEX "cms_media_sizes_card_sizes_card_filename_idx" ON "cms_media" USING btree ("sizes_card_filename");
  CREATE INDEX "cms_media_sizes_hero_sizes_hero_filename_idx" ON "cms_media" USING btree ("sizes_hero_filename");
  CREATE UNIQUE INDEX "cms_news_slug_idx" ON "cms_news" USING btree ("slug");
  CREATE INDEX "cms_news_cover_idx" ON "cms_news" USING btree ("cover_id");
  CREATE INDEX "cms_news_org_id_idx" ON "cms_news" USING btree ("org_id");
  CREATE INDEX "cms_news_seo_seo_image_idx" ON "cms_news" USING btree ("seo_image_id");
  CREATE INDEX "cms_news_updated_at_idx" ON "cms_news" USING btree ("updated_at");
  CREATE INDEX "cms_news_created_at_idx" ON "cms_news" USING btree ("created_at");
  CREATE INDEX "cms_news__status_idx" ON "cms_news" USING btree ("_status");
  CREATE INDEX "_cms_news_v_parent_idx" ON "_cms_news_v" USING btree ("parent_id");
  CREATE INDEX "_cms_news_v_version_version_slug_idx" ON "_cms_news_v" USING btree ("version_slug");
  CREATE INDEX "_cms_news_v_version_version_cover_idx" ON "_cms_news_v" USING btree ("version_cover_id");
  CREATE INDEX "_cms_news_v_version_version_org_id_idx" ON "_cms_news_v" USING btree ("version_org_id");
  CREATE INDEX "_cms_news_v_version_seo_version_seo_image_idx" ON "_cms_news_v" USING btree ("version_seo_image_id");
  CREATE INDEX "_cms_news_v_version_version_updated_at_idx" ON "_cms_news_v" USING btree ("version_updated_at");
  CREATE INDEX "_cms_news_v_version_version_created_at_idx" ON "_cms_news_v" USING btree ("version_created_at");
  CREATE INDEX "_cms_news_v_version_version__status_idx" ON "_cms_news_v" USING btree ("version__status");
  CREATE INDEX "_cms_news_v_created_at_idx" ON "_cms_news_v" USING btree ("created_at");
  CREATE INDEX "_cms_news_v_updated_at_idx" ON "_cms_news_v" USING btree ("updated_at");
  CREATE INDEX "_cms_news_v_latest_idx" ON "_cms_news_v" USING btree ("latest");
  CREATE INDEX "cms_pages_blocks_hero_order_idx" ON "cms_pages_blocks_hero" USING btree ("_order");
  CREATE INDEX "cms_pages_blocks_hero_parent_id_idx" ON "cms_pages_blocks_hero" USING btree ("_parent_id");
  CREATE INDEX "cms_pages_blocks_hero_path_idx" ON "cms_pages_blocks_hero" USING btree ("_path");
  CREATE INDEX "cms_pages_blocks_hero_image_idx" ON "cms_pages_blocks_hero" USING btree ("image_id");
  CREATE INDEX "cms_pages_blocks_rich_text_order_idx" ON "cms_pages_blocks_rich_text" USING btree ("_order");
  CREATE INDEX "cms_pages_blocks_rich_text_parent_id_idx" ON "cms_pages_blocks_rich_text" USING btree ("_parent_id");
  CREATE INDEX "cms_pages_blocks_rich_text_path_idx" ON "cms_pages_blocks_rich_text" USING btree ("_path");
  CREATE INDEX "cms_pages_blocks_media_order_idx" ON "cms_pages_blocks_media" USING btree ("_order");
  CREATE INDEX "cms_pages_blocks_media_parent_id_idx" ON "cms_pages_blocks_media" USING btree ("_parent_id");
  CREATE INDEX "cms_pages_blocks_media_path_idx" ON "cms_pages_blocks_media" USING btree ("_path");
  CREATE INDEX "cms_pages_blocks_media_image_idx" ON "cms_pages_blocks_media" USING btree ("image_id");
  CREATE INDEX "cms_pages_blocks_division_spotlight_order_idx" ON "cms_pages_blocks_division_spotlight" USING btree ("_order");
  CREATE INDEX "cms_pages_blocks_division_spotlight_parent_id_idx" ON "cms_pages_blocks_division_spotlight" USING btree ("_parent_id");
  CREATE INDEX "cms_pages_blocks_division_spotlight_path_idx" ON "cms_pages_blocks_division_spotlight" USING btree ("_path");
  CREATE UNIQUE INDEX "cms_pages_slug_idx" ON "cms_pages" USING btree ("slug");
  CREATE INDEX "cms_pages_org_id_idx" ON "cms_pages" USING btree ("org_id");
  CREATE INDEX "cms_pages_updated_at_idx" ON "cms_pages" USING btree ("updated_at");
  CREATE INDEX "cms_pages_created_at_idx" ON "cms_pages" USING btree ("created_at");
  CREATE INDEX "cms_pages__status_idx" ON "cms_pages" USING btree ("_status");
  CREATE INDEX "_cms_pages_v_blocks_hero_order_idx" ON "_cms_pages_v_blocks_hero" USING btree ("_order");
  CREATE INDEX "_cms_pages_v_blocks_hero_parent_id_idx" ON "_cms_pages_v_blocks_hero" USING btree ("_parent_id");
  CREATE INDEX "_cms_pages_v_blocks_hero_path_idx" ON "_cms_pages_v_blocks_hero" USING btree ("_path");
  CREATE INDEX "_cms_pages_v_blocks_hero_image_idx" ON "_cms_pages_v_blocks_hero" USING btree ("image_id");
  CREATE INDEX "_cms_pages_v_blocks_rich_text_order_idx" ON "_cms_pages_v_blocks_rich_text" USING btree ("_order");
  CREATE INDEX "_cms_pages_v_blocks_rich_text_parent_id_idx" ON "_cms_pages_v_blocks_rich_text" USING btree ("_parent_id");
  CREATE INDEX "_cms_pages_v_blocks_rich_text_path_idx" ON "_cms_pages_v_blocks_rich_text" USING btree ("_path");
  CREATE INDEX "_cms_pages_v_blocks_media_order_idx" ON "_cms_pages_v_blocks_media" USING btree ("_order");
  CREATE INDEX "_cms_pages_v_blocks_media_parent_id_idx" ON "_cms_pages_v_blocks_media" USING btree ("_parent_id");
  CREATE INDEX "_cms_pages_v_blocks_media_path_idx" ON "_cms_pages_v_blocks_media" USING btree ("_path");
  CREATE INDEX "_cms_pages_v_blocks_media_image_idx" ON "_cms_pages_v_blocks_media" USING btree ("image_id");
  CREATE INDEX "_cms_pages_v_blocks_division_spotlight_order_idx" ON "_cms_pages_v_blocks_division_spotlight" USING btree ("_order");
  CREATE INDEX "_cms_pages_v_blocks_division_spotlight_parent_id_idx" ON "_cms_pages_v_blocks_division_spotlight" USING btree ("_parent_id");
  CREATE INDEX "_cms_pages_v_blocks_division_spotlight_path_idx" ON "_cms_pages_v_blocks_division_spotlight" USING btree ("_path");
  CREATE INDEX "_cms_pages_v_parent_idx" ON "_cms_pages_v" USING btree ("parent_id");
  CREATE INDEX "_cms_pages_v_version_version_slug_idx" ON "_cms_pages_v" USING btree ("version_slug");
  CREATE INDEX "_cms_pages_v_version_version_org_id_idx" ON "_cms_pages_v" USING btree ("version_org_id");
  CREATE INDEX "_cms_pages_v_version_version_updated_at_idx" ON "_cms_pages_v" USING btree ("version_updated_at");
  CREATE INDEX "_cms_pages_v_version_version_created_at_idx" ON "_cms_pages_v" USING btree ("version_created_at");
  CREATE INDEX "_cms_pages_v_version_version__status_idx" ON "_cms_pages_v" USING btree ("version__status");
  CREATE INDEX "_cms_pages_v_created_at_idx" ON "_cms_pages_v" USING btree ("created_at");
  CREATE INDEX "_cms_pages_v_updated_at_idx" ON "_cms_pages_v" USING btree ("updated_at");
  CREATE INDEX "_cms_pages_v_latest_idx" ON "_cms_pages_v" USING btree ("latest");
  CREATE INDEX "cms_partners_logo_idx" ON "cms_partners" USING btree ("logo_id");
  CREATE INDEX "cms_partners_org_id_idx" ON "cms_partners" USING btree ("org_id");
  CREATE INDEX "cms_partners_updated_at_idx" ON "cms_partners" USING btree ("updated_at");
  CREATE INDEX "cms_partners_created_at_idx" ON "cms_partners" USING btree ("created_at");
  CREATE INDEX "cms_partners__status_idx" ON "cms_partners" USING btree ("_status");
  CREATE INDEX "_cms_partners_v_parent_idx" ON "_cms_partners_v" USING btree ("parent_id");
  CREATE INDEX "_cms_partners_v_version_version_logo_idx" ON "_cms_partners_v" USING btree ("version_logo_id");
  CREATE INDEX "_cms_partners_v_version_version_org_id_idx" ON "_cms_partners_v" USING btree ("version_org_id");
  CREATE INDEX "_cms_partners_v_version_version_updated_at_idx" ON "_cms_partners_v" USING btree ("version_updated_at");
  CREATE INDEX "_cms_partners_v_version_version_created_at_idx" ON "_cms_partners_v" USING btree ("version_created_at");
  CREATE INDEX "_cms_partners_v_version_version__status_idx" ON "_cms_partners_v" USING btree ("version__status");
  CREATE INDEX "_cms_partners_v_created_at_idx" ON "_cms_partners_v" USING btree ("created_at");
  CREATE INDEX "_cms_partners_v_updated_at_idx" ON "_cms_partners_v" USING btree ("updated_at");
  CREATE INDEX "_cms_partners_v_latest_idx" ON "_cms_partners_v" USING btree ("latest");
  CREATE INDEX "cms_site_settings_socials_order_idx" ON "cms_site_settings_socials" USING btree ("_order");
  CREATE INDEX "cms_site_settings_socials_parent_id_idx" ON "cms_site_settings_socials" USING btree ("_parent_id");
  CREATE INDEX "cms_site_settings_logo_idx" ON "cms_site_settings" USING btree ("logo_id");
  CREATE INDEX "cms_site_settings_default_seo_default_seo_image_idx" ON "cms_site_settings" USING btree ("default_seo_image_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_cms_media_fk" FOREIGN KEY ("cms_media_id") REFERENCES "public"."cms_media"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_cms_news_fk" FOREIGN KEY ("cms_news_id") REFERENCES "public"."cms_news"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_cms_pages_fk" FOREIGN KEY ("cms_pages_id") REFERENCES "public"."cms_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_cms_partners_fk" FOREIGN KEY ("cms_partners_id") REFERENCES "public"."cms_partners"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_cms_media_id_idx" ON "payload_locked_documents_rels" USING btree ("cms_media_id");
  CREATE INDEX "payload_locked_documents_rels_cms_news_id_idx" ON "payload_locked_documents_rels" USING btree ("cms_news_id");
  CREATE INDEX "payload_locked_documents_rels_cms_pages_id_idx" ON "payload_locked_documents_rels" USING btree ("cms_pages_id");
  CREATE INDEX "payload_locked_documents_rels_cms_partners_id_idx" ON "payload_locked_documents_rels" USING btree ("cms_partners_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "cms_media" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "cms_news" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_cms_news_v" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "cms_pages_blocks_hero" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "cms_pages_blocks_rich_text" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "cms_pages_blocks_media" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "cms_pages_blocks_division_spotlight" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "cms_pages" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_cms_pages_v_blocks_hero" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_cms_pages_v_blocks_rich_text" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_cms_pages_v_blocks_media" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_cms_pages_v_blocks_division_spotlight" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_cms_pages_v" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "cms_partners" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_cms_partners_v" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "cms_site_settings_socials" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "cms_site_settings" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "cms_recruitment" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "cms_media" CASCADE;
  DROP TABLE "cms_news" CASCADE;
  DROP TABLE "_cms_news_v" CASCADE;
  DROP TABLE "cms_pages_blocks_hero" CASCADE;
  DROP TABLE "cms_pages_blocks_rich_text" CASCADE;
  DROP TABLE "cms_pages_blocks_media" CASCADE;
  DROP TABLE "cms_pages_blocks_division_spotlight" CASCADE;
  DROP TABLE "cms_pages" CASCADE;
  DROP TABLE "_cms_pages_v_blocks_hero" CASCADE;
  DROP TABLE "_cms_pages_v_blocks_rich_text" CASCADE;
  DROP TABLE "_cms_pages_v_blocks_media" CASCADE;
  DROP TABLE "_cms_pages_v_blocks_division_spotlight" CASCADE;
  DROP TABLE "_cms_pages_v" CASCADE;
  DROP TABLE "cms_partners" CASCADE;
  DROP TABLE "_cms_partners_v" CASCADE;
  DROP TABLE "cms_site_settings_socials" CASCADE;
  DROP TABLE "cms_site_settings" CASCADE;
  DROP TABLE "cms_recruitment" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_cms_media_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_cms_news_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_cms_pages_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_cms_partners_fk";
  
  DROP INDEX "payload_locked_documents_rels_cms_media_id_idx";
  DROP INDEX "payload_locked_documents_rels_cms_news_id_idx";
  DROP INDEX "payload_locked_documents_rels_cms_pages_id_idx";
  DROP INDEX "payload_locked_documents_rels_cms_partners_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "cms_media_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "cms_news_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "cms_pages_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "cms_partners_id";
  DROP TYPE "public"."enum_cms_news_status";
  DROP TYPE "public"."enum__cms_news_v_version_status";
  DROP TYPE "public"."enum_cms_pages_status";
  DROP TYPE "public"."enum__cms_pages_v_version_status";
  DROP TYPE "public"."enum_cms_partners_tier";
  DROP TYPE "public"."enum_cms_partners_status";
  DROP TYPE "public"."enum__cms_partners_v_version_tier";
  DROP TYPE "public"."enum__cms_partners_v_version_status";
  DROP TYPE "public"."enum_cms_site_settings_socials_network";`)
}
