"""Sample the router service's task counts and target-tracking alarm states every 15 s; at the end, write the
scaling activities. Usage: watch_scaling.py --region R --out DIR --minutes N"""
import argparse
import json
import time
from pathlib import Path

import common

p = argparse.ArgumentParser()
p.add_argument('--region', required=True)
p.add_argument('--prefix', default='llmar')
p.add_argument('--out', required=True)
p.add_argument('--minutes', type=float, default=55)
a = p.parse_args()
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
s = common.session(a.region)
o = common.outputs(s, a.prefix)
ecs, cw, aas = s.client('ecs'), s.client('cloudwatch'), s.client('application-autoscaling')
rid = f"service/{o['ClusterName']}/{o['ServiceName']}"
t_end = time.time() + a.minutes * 60
with open(out / 'scaling-samples.jsonl', 'a') as f:
    while time.time() < t_end:
        try:
            v = ecs.describe_services(cluster=o['ClusterName'], services=[o['ServiceName']])['services'][0]
            al = cw.describe_alarms(AlarmNamePrefix=f'TargetTracking-{rid}')['MetricAlarms']
            f.write(json.dumps({'ts': time.time(), 'running': v['runningCount'], 'desired': v['desiredCount'], 'pending': v['pendingCount'],
                                'alarms': {('high' if 'AlarmHigh' in x['AlarmName'] else 'low'): x['StateValue'] for x in al}}) + '\n')
            f.flush()
        except Exception as e:  # noqa: BLE001 - keep sampling
            f.write(json.dumps({'ts': time.time(), 'error': type(e).__name__}) + '\n')
        time.sleep(15)  # nosemgrep: arbitrary-sleep -- sampling interval of the task-count and alarm watcher
acts = aas.describe_scaling_activities(ServiceNamespace='ecs', ResourceId=rid)['ScalingActivities']
(out / 'scaling-activities.json').write_text(json.dumps([{'start': x['StartTime'].isoformat(), 'end': x.get('EndTime') and x['EndTime'].isoformat(),
                                                           'status': x['StatusCode'], 'desc': x['Description'], 'cause': x['Cause']} for x in acts], indent=1))
