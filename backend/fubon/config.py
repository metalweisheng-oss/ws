import os
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

FUBON_ID      = os.getenv('FUBON_ID', '')
FUBON_API_KEY = os.getenv('FUBON_API_KEY', '')
DATABASE_URL  = os.getenv('DATABASE_URL', '')
