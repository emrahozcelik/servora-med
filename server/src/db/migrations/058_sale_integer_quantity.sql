-- SALE-QTY-001: product count, independent of catalog/physical measurement units.
-- Remove the scale typmod so PostgreSQL checks the exact input, before rounding.
LOCK TABLE job_card_sale_items IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM job_card_sale_items
    WHERE quantity < 1 OR quantity <> trunc(quantity) OR quantity > 999999999
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'SALE-QTY-001: historical Sale quantities require data-owner remediation',
      HINT = 'Stop the upgrade. Do not round, truncate or delete historical Sale quantities automatically.';
  END IF;
END $$;

ALTER TABLE job_card_sale_items
  ALTER COLUMN quantity TYPE NUMERIC;

ALTER TABLE job_card_sale_items
  ADD CONSTRAINT job_card_sale_items_integer_quantity_check
  CHECK (quantity >= 1 AND quantity = trunc(quantity) AND quantity <= 999999999);
