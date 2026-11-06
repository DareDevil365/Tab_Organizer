"""Explicit completion, kept separate from opening a resource or tracking time."""
from urllib.parse import urlparse
from sqlalchemy import inspect


def migrate_completion_column(connection):
    # The app already supports additive SQLite startup migrations. Fail visibly
    # rather than serving page queries against an incompatible old schema.
    columns = {column['name'] for column in inspect(connection).get_columns('pages')}
    if 'completed_at' not in columns:
        connection.exec_driver_sql('ALTER TABLE pages ADD COLUMN completed_at TIMESTAMP')


def completion_kind(page) -> str:
    host = (page.domain or urlparse(page.url_original).hostname or '').lower().removeprefix('www.')
    video_hosts = ('youtube.com', 'youtu.be', 'vimeo.com')
    return 'watched' if any(host == site or host.endswith('.' + site) for site in video_hosts) else 'read'
