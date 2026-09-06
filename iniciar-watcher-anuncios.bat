@echo off
cd /d "%~dp0"
echo Watcher de anuncios novos - Starlecos
echo Pasta vigiada: C:\Users\pedro\Fotos-Novos-Anuncios (mude a variavel ANUNCIOS_PASTA_RAIZ se quiser outra)
echo Deixe esta janela aberta enquanto quiser o watcher rodando.
node watcher-anuncios.js
pause
