"""Run `python validate_contracts.py` after `pip install jsonschema`.
Validates all included wire fixtures against the frozen JSON Schema definitions.
"""
import json
from pathlib import Path
from jsonschema import Draft202012Validator, validate

root = Path(__file__).resolve().parent
schema = json.loads((root / 'contracts.schema.json').read_text())
fixtures = json.loads((root / 'example-payloads.json').read_text())
map_types = {
    'telemetry_event': 'TelemetryEvent',
    'hardware_sample': 'HardwareSample',
    'action_command': 'ActionCommand',
    'job_spec': 'JobSpec',
    'fault_injection_private': 'FaultInjection'
}
Draft202012Validator.check_schema(schema)
for name, type_name in map_types.items():
    validate(fixtures[name], {'$schema': schema['$schema'],
        '$defs': schema['$defs'], '$ref': '#/$defs/' + type_name})
    print('OK', name, type_name)
