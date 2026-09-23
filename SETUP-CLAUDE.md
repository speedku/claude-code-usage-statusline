# Instalacja rotacji kont Claude: instrukcja dla Claude Code

Ten plik czyta Claude Code na komputerze użytkownika, który chce korzystać z kilku kont Claude
naprzemiennie. Wykonaj kroki po kolei, na tym komputerze, i rozmawiaj z użytkownikiem po polsku,
prostym językiem. Na końcu użytkownik ma: pasek statusu z limitami wszystkich kont, komendę
`claude-best`, która uruchamia Claude na koncie z największym zapasem, i zalogowane konta.

System: Windows. Pliki narzędzi bierzesz z tego repozytorium:
`https://raw.githubusercontent.com/speedku/claude-code-usage-statusline/master/<ścieżka>`.

## Zasada, którą przekazujesz użytkownikowi na starcie i na końcu

Konto zmienia się **przy starcie sesji**, nigdy w jej trakcie: przez `claude-best`,
`cswap run N` albo `cswap switch N`. Komendy `/login` i `/logout` w zwykłym oknie Claude
wylogowują konto, z którego się wychodzi, i unieważniają jego kopię w claude-swap. Tak w firmie
wypadły dwa konta 23.09.2026. Każde konto loguje się raz, przez skrypt z kroku 5.

## Krok 1. Sprawdzenie stanu

Sprawdź, co już jest: `node --version`, `uv --version`, `cswap --version`, czy istnieją
`~/.claude/hooks/statusline-usage.js` i `~/.local/bin/claude-best.cmd`, i co stoi w kluczu
`statusLine` w `~/.claude/settings.json`.

Gotowe, gdy znasz listę brakujących elementów. Istniejące i aktualne pomijasz w dalszych krokach.

## Krok 2. uv i claude-swap

Brak `uv`: zainstaluj oficjalnym instalatorem Astral (PowerShell):
`powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`.
Potem: `uv tool install claude-swap`. Oba trafiają do `~/.local/bin`.

Gotowe, gdy `cswap --version` w nowym oknie PowerShell zwraca numer wersji.

## Krok 3. Pasek statusu

1. Pobierz `hooks/statusline-usage.js` i `hooks/statusline-refresh.js` do `~/.claude/hooks/`
   (oba w tym samym katalogu, pierwszy uruchamia drugi).
2. W `~/.claude/settings.json` ustaw klucz `statusLine`, zachowując resztę pliku bez zmian:
   `{"type": "command", "command": "node \"C:\\Users\\<użytkownik>\\.claude\\hooks\\statusline-usage.js\""}`
   z prawdziwą ścieżką katalogu domowego. Gdy użytkownik ma już inny `statusLine`, pokaż mu go
   i zapytaj, czy zastąpić.

Gotowe, gdy test przechodzi: plik JSON `{"model":{"id":"claude-opus","display_name":"Opus"},"context_window":{"used_percentage":10},"cwd":"C:\\"}`
zapisany narzędziem Write (echo w Git Bash psuje ukośniki) i podany na wejście
`node ~/.claude/hooks/statusline-usage.js` wypisuje wiersz zaczynający się od nazwy modelu,
a nie samo słowo `Claude`.

## Krok 4. Narzędzia do kont

Pobierz do `~/.local/bin/`: `tools/claude-best.ps1`, `tools/claude-best.cmd`,
`tools/claude-add-account.cmd`. Pliki `.ps1` zapisuj jako ASCII lub UTF-8 bez BOM.

Gotowe, gdy `claude-best -n` w nowym oknie PowerShell odpowiada tabelą albo komunikatem
o braku kont (a nie błędem „nie rozpoznano polecenia”).

## Krok 5. Logowanie kont (robi użytkownik, Ty prowadzisz)

Logowanie wymaga przeglądarki i hasła, więc wykonuje je użytkownik. Dla każdego konta podaj mu:

1. Otwórz **nowe okno terminala** (poza Claude).
2. Wpisz `claude-add-account.cmd 1` (dla kolejnych kont 2, 3, 4...).
3. Otworzy się czysty Claude: zaloguj się na to konto, potem wpisz `/exit`.

Skrypt loguje w osobnym, pustym katalogu, więc nic innego się nie wylogowuje, zapisuje konto
w claude-swap pod podanym numerem i sprząta. Poproś, żeby napisał, gdy skończy wszystkie konta.

Gotowe, gdy `cswap list` pokazuje każde konto z procentami 5h i 7d, bez „re-login needed”.

## Krok 6. Odbiór i instrukcja dla użytkownika

Uruchom `claude-best -n` i pokaż wynik. Potem przekaż użytkownikowi, krótko:

- **Nowe okno Claude:** w terminalu `claude-best` zamiast `claude`. Wybiera konto z największym
  zapasem limitu tygodniowego (z uwzględnieniem planu: Max 20x liczy się 4 razy więcej niż Max 5x,
  gdy istnieje plik `~/.claude-konta-plany.json`) i uruchamia Claude tylko w tym oknie.
- **Wszystkie okna naraz:** w oknie Claude `! cswap switch N` (z wykrzyknikiem). Rozmowy zostają.
- **Jedno okno:** `/exit`, potem `claude-best` albo `cswap run N`. Na Windows historia rozmów
  jest osobna dla każdego konta.
- **Claude w Chrome:** wtyczka jest przypięta do konta, nie do komputera, i po zmianie konta
  zostaje na starym. Okno do pracy w przeglądarce uruchamiaj przez `cswap run N` z kontem
  zalogowanym we wtyczce albo przeloguj wtyczkę (adres ustawień
  `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/options.html`, przycisk Log out).
- **Pasek na dole:** wiersz `⇄` z limitami wszystkich kont i podpowiedzią, na które przejść.
- **Konto z „re-login needed”:** `claude-add-account.cmd N` w nowym terminalu.
- **Zasada** z początku tego pliku, słowo w słowo.

Gotowe, gdy użytkownik potwierdzi, że po ponownym uruchomieniu Claude widzi pasek z kontami.

## Gdy coś nie działa

| Objaw | Przyczyna i naprawa |
|---|---|
| Pasek pokazuje samo `Claude` | błąd w danych wejściowych albo brak Node; uruchom skrypt ręcznie z plikiem testowym z kroku 3 |
| Brak wiersza `⇄` | w claude-swap są mniej niż 2 konta (`cswap list`) |
| `re-login needed` przy koncie | token unieważniony (zwykle po `/login` w zwykłym oknie); `claude-add-account.cmd N` |
| Limity sprzed wielu minut | claude-swap odpytuje limity najwyżej co 3 minuty na konto (limit po stronie Anthropic); to normalne |
