import os
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

FUBON_ID      = os.getenv('FUBON_ID', '')
FUBON_API_KEY = os.getenv('FUBON_API_KEY', '')
FUBON_CERT    = os.getenv('FUBON_CERT', os.path.join(os.path.dirname(__file__), 'D122054524.pfx'))
FUBON_CERT_PASS = os.getenv('FUBON_CERT_PASS', 'Fb054584')
DATABASE_URL  = os.getenv('DATABASE_URL', '')
