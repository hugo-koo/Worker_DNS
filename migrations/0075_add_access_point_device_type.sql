-- Add device_type column to access_points so each Access Point can declare its browser, OS, router, or TV/NAS form factor.
ALTER TABLE access_points ADD COLUMN device_type TEXT NOT NULL DEFAULT 'other_device';
