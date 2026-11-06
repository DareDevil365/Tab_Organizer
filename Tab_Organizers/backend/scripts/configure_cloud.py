"""Collect cloud credentials locally without echoing secrets or changing local mode."""
import argparse
import getpass
import json
import os
import re
import secrets
import sys
from pathlib import Path
from urllib.parse import quote, urlparse, parse_qsl, urlencode, urlunparse
from dotenv import dotenv_values

ROOT=Path(__file__).resolve().parents[1]
FILE=ROOT/'.env.cloud'
FIELDS=('DATABASE_URL','CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','SUPABASE_URL','GEMINI_API_KEY','BACKEND_API_KEY','CRON_SECRET')


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--check',action='store_true');args=parser.parse_args()
    values={**dotenv_values(ROOT/'.env'),**dotenv_values(FILE)}
    if args.check:
        missing=[field for field in FIELDS if not values.get(field)]
        print('Missing fields: '+', '.join(missing) if missing else 'All required cloud fields are filled. Credentials have not been tested.')
        return 1 if missing else 0
    print('Credentials stay in backend/.env.cloud. Nothing is uploaded by this command.')
    print('Press Enter to retain a saved value. Secret inputs are hidden.')
    prompts={
        'DATABASE_URL':'Supabase Connect > Transaction pooler connection string',
        'CLOUDFLARE_ACCOUNT_ID':'Cloudflare account ID',
        'CLOUDFLARE_API_TOKEN':'Cloudflare Workers AI API token',
        'SUPABASE_URL':'Supabase project URL',
        'GEMINI_API_KEY':'Gemini API key from a free-tier project',
    }
    hidden={'DATABASE_URL','CLOUDFLARE_API_TOKEN','GEMINI_API_KEY'}
    for field,prompt in prompts.items():
        marker=' [saved]' if values.get(field) else ''
        entered=(getpass.getpass if field in hidden else input)(prompt+marker+': ').strip()
        if entered:values[field]=entered
        if field=='DATABASE_URL' and values.get(field) and re.search(r'\[YOUR[-_]PASSWORD\]',values[field],re.I):
            password=getpass.getpass('Supabase database password: ')
            values[field]=re.sub(r'\[YOUR[-_]PASSWORD\]',quote(password,safe=''),values[field],flags=re.I)
    if not values.get('DATABASE_URL','').startswith(('postgres://','postgresql://','postgresql+psycopg://')):raise ValueError('A PostgreSQL connection string is required')
    database=urlparse(values['DATABASE_URL']);query=dict(parse_qsl(database.query));query['sslmode']='require'
    values['DATABASE_URL']=urlunparse(database._replace(query=urlencode(query)))
    if not re.fullmatch(r'[a-fA-F0-9]{32}',values.get('CLOUDFLARE_ACCOUNT_ID','')):raise ValueError('The Cloudflare Account ID should contain 32 hexadecimal characters')
    url=urlparse(values.get('SUPABASE_URL',''))
    if url.scheme!='https' or not (url.hostname or '').endswith('.supabase.co'):raise ValueError('Enter the HTTPS Supabase project URL')
    values['CRON_SECRET']=values.get('CRON_SECRET') or secrets.token_hex(32)
    values['BACKEND_API_KEY']=values.get('BACKEND_API_KEY') or secrets.token_hex(32)
    missing=[field for field in FIELDS if not values.get(field)]
    if missing:raise ValueError('Missing fields: '+', '.join(missing))
    lines=['# Private cloud deployment settings. Never commit this file.','APP_MODE=cloud','EMBEDDING_PROVIDER=cloudflare','CLASSIFY_ON_STARTUP=false']
    lines.extend(field+'='+json.dumps(values[field]) for field in FIELDS)
    FILE.write_text('\n'.join(lines)+'\n',encoding='utf-8')
    if os.name!='nt':FILE.chmod(0o600)
    print('Private cloud configuration saved. The local backend configuration is unchanged.')
    return 0


if __name__=='__main__':
    try:sys.exit(main())
    except (ValueError,KeyboardInterrupt,EOFError) as error:
        print(str(error) if isinstance(error,ValueError) else 'Setup cancelled. Existing settings were preserved.');sys.exit(1)
