"""Inspect first; --apply copies a consistent SQLite snapshot into an empty cloud DB."""
import argparse
import datetime as dt
import json
import os
import sqlite3
import sys
from pathlib import Path
from urllib.parse import quote

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))


from app.services.cloud_migration import migrate


def main():
    os.environ['TAB_ORGANIZER_PROFILE']='cloud'
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--apply',action='store_true');parser.add_argument('--backend-url');args=parser.parse_args()
    from app.config import settings
    from app.auth import validate_cloud_settings
    from app.database import database_url
    validate_cloud_settings()
    if args.backend_url:
        return migrate_https(args.backend_url,args.apply,settings.BACKEND_API_KEY)
    result=migrate(ROOT/'data/tab_organizer.db',database_url(settings.DATABASE_URL),args.apply,ROOT.parents[1]/'output/playwright/cloud-migration')
    print(json.dumps(result,indent=2))
    if not args.apply:print('Dry run only. No tables or data were changed. Run with --apply after reviewing the counts.')


def migrate_https(url, apply, key):
    import httpx,io,zipfile
    from urllib.parse import urlparse
    parsed=urlparse(url)
    if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.query or parsed.fragment or parsed.path not in ('','/'):raise ValueError('Use the HTTPS backend base URL')
    url=url.rstrip('/');headers={'Authorization':'Bearer '+key}
    with httpx.Client(timeout=300) as client:
        status=client.get(url+'/api/setup/status',headers=headers)
        if status.status_code!=200:raise ValueError('The deployed backend could not verify its database connection')
        state=status.json()
        print(json.dumps({'database_connected':state.get('database_connected'),'target_empty':state.get('empty')},indent=2))
        if not state.get('empty'):raise ValueError('The cloud library already contains data. No upload was made.')
        if not apply:
            print('Dry run only. Add --apply to upload the private snapshot.');return
        source=sqlite3.connect('file:'+quote(str((ROOT/'data/tab_organizer.db').resolve()).replace('\\','/'),safe='/:')+'?mode=ro',uri=True)
        memory=sqlite3.connect(':memory:');source.backup(memory);source.close()
        backup_dir=ROOT.parents[1]/'output/playwright/cloud-migration';backup_dir.mkdir(parents=True,exist_ok=True)
        backup=sqlite3.connect(str(backup_dir/('before-cloud-https-'+dt.datetime.now().strftime('%Y%m%d-%H%M%S')+'.sqlite3')));memory.backup(backup);backup.close()
        output=io.BytesIO()
        documents=('closed_windows.json','browser_sessions.json','terminator_rules.json','taxonomy_rules.json','taxonomy.json','generated_topic_paths.json','topic_heading_aliases.json')
        with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('database.sqlite3',memory.serialize())
            for name in documents:
                path=ROOT/'data'/name
                if path.is_file():archive.write(path,name)
        memory.close();payload=output.getvalue()
        if len(payload)>4*1024*1024:raise ValueError('The migration archive is larger than the HTTPS upload limit')
        response=client.post(url+'/api/setup/import',content=payload,headers={**headers,'Content-Type':'application/octet-stream'})
        if response.status_code!=200:raise ValueError('The migration did not complete. Local data is unchanged.')
        print(json.dumps(response.json(),indent=2))


if __name__=='__main__':
    try:main()
    except Exception:
        # Connection exceptions may contain credentials. Show them only through
        # a deliberate local debugger, never in a setup transcript or CI log.
        print('Migration did not complete. Check private connection settings, target emptiness and connectivity. No source data was changed.');sys.exit(1)
