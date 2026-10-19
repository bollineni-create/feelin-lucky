import { getDb, DB_PATH } from "@/lib/db";

// Opening the database applies any pending migrations.
getDb();
console.log(`Migrations applied to ${DB_PATH}`);
