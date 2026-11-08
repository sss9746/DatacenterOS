"""Run `python validate_contracts.py` after `pip install jsonschema`.
Validates every fixture in example-payloads.json against the frozen JSON Schema definitions.
Paths resolve relative to this file, so it runs from any working directory.
"""
import json
import sys
from pathlib import Path
from jsonschema import Draft202012Validator, validate

root = Path(__file__).resolve().parent
schema = json.loads((root / 'contracts.schema.json').read_text(encoding='utf-8'))
fixtures = json.loads((root / 'example-payloads.json').read_text(encoding='utf-8'))
map_types = {
    'telemetry_event': 'TelemetryEvent',
    'hardware_sample': 'HardwareSample',
    'hardware_sample_microphone': 'HardwareSample',
    'action_command': 'ActionCommand',
    'job_spec': 'JobSpec',
    'fault_injection_private': 'FaultInjection',
    'evaluation_result_provenance': 'EvaluationResult'
}

unmapped = sorted(set(fixtures) - set(map_types))
if unmapped:
    sys.exit('FAIL: fixtures without a type mapping: ' + ', '.join(unmapped))

Draft202012Validator.check_schema(schema)
for name, type_name in map_types.items():
    validate(fixtures[name], {'$schema': schema['$schema'],
        '$defs': schema['$defs'], '$ref': '#/$defs/' + type_name})
    print('OK', name, type_name)
print(f'All {len(map_types)} fixtures valid.')
