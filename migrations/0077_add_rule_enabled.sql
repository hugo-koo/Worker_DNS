-- Migration: Add enabled flag to custom rules so individual rules can be disabled without deletion
ALTER TABLE rules ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
