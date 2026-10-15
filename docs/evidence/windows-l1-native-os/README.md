# Windows L1: доказательства итерации после a6eb17d

Это журналы разработки, а не акт приёмки WP-23c. Доступность производственного
backend не включена. Проверки, не дошедшие до запуска песочницы, не доказывают отказ доступа.

- `*-checks.json`: полные ответы GitHub о заданиях CI, их состояниях и ссылках.
- `*-tested-merge.json`: проверенные родители фактически тестировавшегося merge-коммита;
  второй родитель должен совпадать с указанным исходным коммитом.
- `*-events.gzip.json`: полные события Windows без потерь, сжаты gzip/base64.
  `decodedBytes` и `decodedSha256` относятся к распакованным байтам.
- `*-local-check.log/json`: полный локальный журнал и сведения о коммите/команде.
  Это Linux x64, Node 24, а НЕ доказательство Windows или macOS.
- `race-red-green.json`, `race-red.log`, `race-tests.log`: новый детерминированный
  тест пропуска блокировки; падение на старой реализации, прохождение после исправления.
  Это не утверждение о доказанной причине всех прежних прерывистых сбоев macOS.

`CROT-6A-metadata.configuration` описывает старую общую restricted-token фикстуру.
Нельзя приписывать её параметры новому AppContainer-контроллеру. Новый контроллер
имеет отдельное событие `CROT-6A-native-appcontainer`; проверяет собственные
package SID, нулевые capabilities, Low IL и принадлежность Job перед каждым ResumeThread.
Результаты тестов также сохранены в событиях `CROT-6A-test-summary`.

Полные исторические журналы в соседних каталогах сохранены неизменными.
`manifest.json` содержит SHA-256 каждого файла этого каталога, кроме самого манифеста.

Проверка упаковки одного файла:

```python
import base64, gzip, hashlib, json, pathlib, sys
p = pathlib.Path(sys.argv[1])
m = json.loads((p.parent / "manifest.json").read_text())
assert hashlib.sha256(p.read_bytes()).hexdigest() == m[p.name]
w = json.loads(p.read_text())
assert w["formatVersion"] == 1 and w["encoding"] == "gzip+base64"
raw = gzip.decompress(base64.b64decode(w["gzipBase64"], validate=True))
assert len(raw) == w["decodedBytes"]
assert hashlib.sha256(raw).hexdigest() == w["decodedSha256"]
events = json.loads(raw)
```
