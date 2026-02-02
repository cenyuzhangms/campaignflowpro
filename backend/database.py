import sqlite3
from pathlib import Path
from typing import List, Dict


DB_PATH = Path(__file__).resolve().parent / "campaign_flow.db"


def init_db():
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS published_packages (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                publish_package TEXT NOT NULL
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def save_published_package(package_id: str, name: str, created_at: str, publish_package: str):
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """
            INSERT INTO published_packages (id, name, created_at, publish_package)
            VALUES (?, ?, ?, ?)
            """,
            (package_id, name, created_at, publish_package),
        )
        conn.commit()
    finally:
        conn.close()


def list_published_packages(limit: int = 20) -> List[Dict]:
    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.execute(
            """
            SELECT id, name, created_at, publish_package
            FROM published_packages
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        )
        rows = cursor.fetchall()
        return [
            {
                "id": row[0],
                "name": row[1],
                "time": row[2],
                "publish_package": row[3],
            }
            for row in rows
        ]
    finally:
        conn.close()
