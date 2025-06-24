@echo off
REM Setup virtual environment and install dependencies
python -m venv venv
call .\venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements.txt
