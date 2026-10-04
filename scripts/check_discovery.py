import subprocess


code = """
import asyncio, json
from fastapi import HTTPException
import app
from recommendations import PickFilters, connection_config

async def check():
    config = connection_config()
    assert config['key'], 'Seerr connection key was not saved'
    assert config['public_url'] and config['jellyfin_url'], 'Public service URLs are missing'
    await app.discovery.seerr('/status', fresh=True)
    users = await app.discovery.jf_get('/Users')
    users = [u for u in users if not (u.get('Policy') or {}).get('IsDisabled')]
    assert users, 'No active Jellyfin viewers'
    selected = None
    for item in users[:10]:
        user = {'id': item['Id'].replace('-', '').lower(), 'name': item['Name']}
        try:
            await app.discovery.account(user)
            selected = user
            break
        except HTTPException as error:
            if error.status_code != 409:
                raise
    user = selected or {'id': users[0]['Id'].replace('-', '').lower(), 'name': users[0]['Name']}
    local = await app.discovery.picks(PickFilters(unseen=False, max_minutes=None), user)
    external = await app.discovery.picks(PickFilters(mode='discover', unseen=False, max_minutes=None), user) if selected else None
    print(json.dumps({'jellyfin_library': 'connected', 'seerr_api': 'connected',
                      'linked_account': bool(selected), 'local_picks': len(local['items']),
                      'discovery_picks': len(external['items']) if external else None,
                      'real_requests_submitted': 0}))
    await app.jf.aclose()
    await app.http.aclose()

asyncio.run(check())
"""


if __name__ == "__main__":
    subprocess.run(["docker", "exec", "-i", "monitor", "python"], input=code, text=True, check=True)
