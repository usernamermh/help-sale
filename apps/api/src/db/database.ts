import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrate.js";

export function openDatabase(databasePath: string): DatabaseSync {
	const db = new DatabaseSync(databasePath);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	migrate(db);
	return db;
}