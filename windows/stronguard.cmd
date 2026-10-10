@echo off
rem Stronguard command line, e.g.:  stronguard status ^| level 4 ^| check ads.example.com
node "%~dp0..\network\bin\stronguard.js" %*
