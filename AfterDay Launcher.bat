@echo off
rem Что касается TDB Launcher (онлайн-режим / офлайн-режим / обновления): для его работы требуется Python с установленным пакетом frida.
cd /d "%~dp0"
where pythonw >nul 2>nul && (start "" pythonw -I "%~dp0launcher\tdb_launcher.py") || (start "" python -I "%~dp0launcher\tdb_launcher.py")
