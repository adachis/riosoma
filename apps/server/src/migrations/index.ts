import { m0143 } from './0143_ingest_originals.js';
import { m0142 } from './0142_ingest_live.js';
import { m0141 } from './0141_ingest_pipeline.js';
import { m0137 } from './0137_ingest_tables.js';
import { m0140 } from './0140_ingest_setup.js';
import { m0123 } from './0123_password_reset_and_sessions.js';
import { m0124 } from './0124_people_profiles.js';
import { m0090 } from './0090_named_functions.js';
import { m0091 } from './0091_cross_database_links.js';
import { m0099 } from './0099_pdf_reports.js';
import { m0100 } from './0100_rio_conversations.js';
import { m0080 } from './0080_select_sources.js';
import { m0081 } from './0081_automation_publication.js';
import { m0082 } from './0082_ai_usage_token_estimates.js';
import { m0086 } from './0086_arrangement_order.js';
import { migration as m0085 } from './0085_remote_tools.js';
import { m0083 } from './0083_automation_steps.js';
import { m0078 } from './0078_home_items.js';
import { m0084 } from './0084_knowledge_libraries.js';
import { m0087 } from './0087_knowledge_index_jobs.js';
import { m0089 } from './0089_cell_comments.js';
import { m0094 } from './0094_form_edit_links.js';
import { m0088 } from './0088_notification_vault_kind.js';
import { m0093 } from './0093_file_scanner.js';
import type { Migration } from '@riosoma/db';
import { m0104 } from './0104_active_link_junctions.js';
import { m0065 } from './0065_record_locks.js';
import { m0001 } from './0001_foundation.js';
import { m0002 } from './0002_data_core.js';
import { m0003 } from './0003_links.js';
import { m0004 } from './0004_files.js';
import { m0005 } from './0005_trash.js';
import { m0006 } from './0006_tokens.js';
import { m0007 } from './0007_sources.js';
import { m0008 } from './0008_comments.js';
import { m0009 } from './0009_rio.js';
import { m0010 } from './0010_public_forms.js';
import { m0011 } from './0011_dashboards.js';
import { m0012 } from './0012_automations.js';
import { m0013 } from './0013_sso.js';
import { m0014 } from './0014_source_order.js';
import { m0015 } from './0015_notifications.js';
import { m0016 } from './0016_mfa.js';
import { m0017 } from './0017_webhooks.js';
import { m0018 } from './0018_shared_views.js';
import { m0019 } from './0019_mfa_replacement.js';
import { m0020 } from './0020_interfaces.js';
import { m0021 } from './0021_airtable_imports.js';
import { m0022 } from './0022_saml.js';
import { m0023 } from './0023_record_positions.js';
import { m0024 } from './0024_database_archives.js';
import { m0025 } from './0025_scheduled_reports.js';
import { m0026 } from './0026_automation_messages.js';
import { m0027 } from './0027_feedback.js';
import { m0028 } from './0028_permissions.js';
import { m0029 } from './0029_platform_imports.js';
import { m0030 } from './0030_file_storage.js';
import { m0031 } from './0031_uploads_scanning.js';
import { m0032 } from './0032_calendar_feeds.js';
import { m0033 } from './0033_scripts.js';
import { m0034 } from './0034_link_inverses.js';
import { m0035 } from './0035_booking_pages.js';
import { m0036 } from './0036_office_report_formats.js';
import { m0037 } from './0037_ai_fields.js';
import { m0038 } from './0038_file_pickers.js';
import { m0040 } from './0040_sql_access.js';
import { m0042 } from './0042_inbound_sources.js';
import { m0044 } from './0044_scim.js';
import { m0045 } from './0045_ai_field_turns.js';
import { m0046 } from './0046_signature_requests.js';
import { m0047 } from './0047_organization_archives.js';
import { m0048 } from './0048_automation_versions.js';
import { m0051 } from './0051_oauth_apps.js';
import { m0052 } from './0052_custom_domains.js';
import { m0053 } from './0053_payments.js';
import { m0056 } from './0056_archive_review.js';
import { m0057 } from './0057_org_units.js';
import { m0058 } from './0058_published_sites.js';
import { m0059 } from './0059_routines.js';
import { m0060 } from './0060_ai_footprint.js';
import { m0061 } from './0061_updates_telemetry.js';
import { m0062 } from './0062_routine_hosts.js';
import { m0076 } from './0076_platform_import_tools.js';
import { m0075 } from './0075_joined_tables.js';
import { m0064 } from './0064_home_folders.js';
import { m0066 } from './0066_admin_roles_audit.js';
import { m0068 } from './0068_knowledge.js';
import { m0069 } from './0069_automation_waits.js';
import { m0070 } from './0070_notification_channels.js';
import { m0071 } from './0071_credential_vaults.js';
import { m0072 } from './0072_sql_access_paths.js';
import { m0073 } from './0073_notification_kinds.js';
import { m0074 } from './0074_governance.js';
import { migration as m0077 } from './0077_public_sharing.js';

import { m0097 } from './0097_line_items.js';
import { m0096 } from './0096_import_platforms.js';

import { m0102 } from './0102_feedback_hub.js';
import { m0109 } from './0109_duplicate_actions.js';
/**
 * Every migration, in order.  Never edit a shipped migration: add a new one.
 * Record additions with the command in docs/developer/migrations.md.
 */
import { m0126 } from './0126_automation_notifications.js';
import { m0125 } from './0125_pending_shares.js';
import { m0130 } from './0130_copied_invitations.js';
import { m0131 } from './0131_sql_views_give_way.js';
import { m0132 } from './0132_outbound_syncs.js';
import { m0133 } from './0133_notification_kinds.js';
import { m0134 } from './0134_demo_sessions.js';
import { m0136 } from './0136_ingest_decisions.js';
import { m0138 } from './0138_ingest_usage.js';
import { m0139 } from './0139_ingest_row_writer.js';

export const MIGRATIONS: Migration[] = [
  m0001,
  m0002,
  m0003,
  m0004,
  m0005,
  m0006,
  m0007,
  m0008,
  m0009,
  m0010,
  m0011,
  m0012,
  m0013,
  m0014,
  m0015,
  m0016,
  m0017,
  m0018,
  m0019,
  m0020,
  m0021,
  m0022,
  m0023,
  m0024,
  m0025,
  m0026,
  m0027,
  m0028,
  m0029,
  m0030,
  m0031,
  m0032,
  m0033,
  m0034,
  m0035,
  m0036,
  m0037,
  m0038,
  m0040,
  m0042,
  m0044,
  m0045,
  m0046,
  m0047,
  m0048,
  m0051,
  m0052,
  m0053,
  m0056,
  m0057,
  m0058,
  m0059,
  m0060,
  m0061,
  m0062,
  m0064,
  m0065,
  m0066,
  m0068,
  m0069,
  m0070,
  m0071,
  m0072,
  m0073,
  m0074,
  m0075,
  m0076,
  m0077,
  m0078,
  m0080,
  m0081,
  m0082,
  m0083,
  m0084,
  m0085,
  m0086,
  m0087,
  m0088,
  m0089,
  m0090,
  m0091,
  m0093,
  m0094,
  m0096,
  m0097,
  m0099,
  m0100,
  m0102,
  m0104,
  m0109,
  m0123,
  m0124,
  m0125,
  m0126,
  m0130,
  m0131,
  m0132,
  m0133,
  m0134,
  m0136,
  m0137,
  m0138,
  m0139,
  m0140,
  m0141,
  m0142,
  m0143,
  m0144,
  m0147,
  m0148,
  m0149,
  m0150,
];
import { m0144 } from './0144_ingest_build.js';

import { m0148 } from './0148_ingest_study.js';
import { m0147 } from './0147_ingest_drafts.js';
import { m0149 } from './0149_ingest_confirmed_findings.js';
import { m0150 } from './0150_elapsed_expiry.js';
