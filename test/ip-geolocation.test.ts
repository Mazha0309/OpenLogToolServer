import assert from 'node:assert/strict';
import test from 'node:test';
import { IpGeolocationResolver } from '../src/operations/ip-geolocation';

test('Baidu IP geolocation returns province, city and district and caches by IP', async () => {
  let requests = 0;
  const resolver = new IpGeolocationResolver('test-ak', async (input) => {
    requests += 1;
    const url = new URL(input);
    assert.equal(url.origin + url.pathname, 'https://api.map.baidu.com/location/ip');
    assert.equal(url.searchParams.get('ip'), '1.2.3.4');
    assert.equal(url.searchParams.get('ak'), 'test-ak');
    return new Response(JSON.stringify({
      status: 0,
      content: {
        address_detail: {
          province: '浙江省',
          city: '杭州市',
          district: '萧山区',
          adcode: 330109,
        },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const expected = {
    province: '浙江省',
    city: '杭州市',
    district: '萧山区',
    adcode: '330109',
    displayName: '浙江省 杭州市 萧山区',
    source: 'baidu-ip',
  };
  assert.deepEqual(await resolver.resolve('1.2.3.4'), expected);
  assert.deepEqual(await resolver.resolve('1.2.3.4'), expected);
  assert.equal(requests, 1);
});

test('IP geolocation skips unconfigured, private, reserved and IPv6 addresses', async () => {
  let requests = 0;
  const fetcher = async () => {
    requests += 1;
    return new Response('{}');
  };
  const configured = new IpGeolocationResolver('test-ak', fetcher);
  const unconfigured = new IpGeolocationResolver(undefined, fetcher);

  assert.equal(await configured.resolve('127.0.0.1'), null);
  assert.equal(await configured.resolve('192.168.1.2'), null);
  assert.equal(await configured.resolve('203.0.113.10'), null);
  assert.equal(await configured.resolve('2001:db8::1'), null);
  assert.equal(await unconfigured.resolve('1.2.3.4'), null);
  assert.equal(requests, 0);
});
