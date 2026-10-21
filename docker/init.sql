-- Runs once, on first start of an empty data volume.
-- The default database `mnemio` comes from POSTGRES_DB; this adds the test database.
CREATE DATABASE mnemio_test OWNER mnemio;
