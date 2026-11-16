-- Migration 0070: Add compiled rule statistics JSON column to global_list_metadata
ALTER TABLE global_list_metadata ADD COLUMN stats TEXT;
