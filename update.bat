@echo off
cd /d C:\Users\kevin\Documents\InvisiProxyLTS-NEW
git pull
pnpm install
pnpm run build
pm2 restart all