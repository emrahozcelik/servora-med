import collections
import json
import os
import pathlib
import sys


MANIFEST = json.loads(pathlib.Path(__file__).with_name('manifest.json').read_text())
COUNT = os.environ['CI_PERF_COUNT']
SHA = os.environ['EXPERIMENT_SHA']


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def validate(files, expected):
    require(files.keys() == expected.keys(), f'File inventory mismatch: {sorted(files.keys() ^ expected.keys())}')
    for file, attempts in files.items():
        counts = collections.Counter(case[-1] for case in attempts)
        total, skipped = expected[file]
        require(counts == +collections.Counter({'passed': total - skipped, 'skipped': skipped}),
                f'{file}: expected {total - skipped} passed, {skipped} skipped; received {dict(counts)}')


def report(scope, index, raw_file, output_file):
    raw = json.loads(pathlib.Path(raw_file).read_text())
    require(raw['success'], 'Vitest failed')
    expected = MANIFEST[scope]
    if scope == 'server':
        expected = {file: expected[file] for file in MANIFEST['groups'][COUNT][index]}
    files = {}
    for result in raw['testResults']:
        file = pathlib.Path(result['name']).relative_to(pathlib.Path.cwd()).as_posix()
        require(file not in files, f'Duplicate file: {file}')
        files[file] = []
        for assertion in result['assertionResults']:
            location = assertion.get('location') or {}
            status = assertion['status']
            if status == 'pending':
                status = 'skipped'
            files[file].append([assertion['ancestorTitles'], assertion['title'],
                                location.get('line'), location.get('column'), status])
    validate(files, expected)
    payload = {'sha': SHA, 'count': COUNT, 'index': index, 'scope': scope, 'files': files}
    pathlib.Path(output_file).write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(f'{scope} {index}/{COUNT}: {len(files)} files, {sum(len(cases) for cases in files.values())} cases')


def gate(artifact_dir):
    folder = pathlib.Path(artifact_dir)
    groups = MANIFEST['groups'][COUNT]
    require({path.name for path in folder.iterdir()} == {f'server-{index}.json' for index in groups},
            'Missing or unexpected shard report')
    all_files = {}
    for index, planned in groups.items():
        payload = json.loads((folder / f'server-{index}.json').read_text())
        require((payload['sha'], payload['count'], payload['index'], payload['scope']) == (SHA, COUNT, index, 'server'),
                f'Mismatched evidence from shard {index}')
        files = payload['files']
        require(not (files.keys() & all_files.keys()), f'Duplicate file across shards at shard {index}')
        validate(files, {file: MANIFEST['server'][file] for file in planned})
        all_files.update(files)
    validate(all_files, MANIFEST['server'])
    print(f'Verified {len(groups)} shards and all {len(all_files)} server test files at {SHA}.')


if __name__ == '__main__':
    if sys.argv[1] == 'report':
        report(*sys.argv[2:])
    else:
        require(sys.argv[1] == 'gate', 'Expected report or gate')
        gate(*sys.argv[2:])
