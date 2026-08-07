ALTER TABLE job_card_notes
  ADD COLUMN invoice_number TEXT,
  ADD CONSTRAINT job_card_notes_invoice_number_length
  CHECK (invoice_number IS NULL OR length(invoice_number) <= 100);
