import assert from 'node:assert/strict';
import test from 'node:test';
import { IpGeolocationResolver } from '../src/operations/ip-geolocation';

test('offline IP geolocation returns country, province, city and ISP and caches by IP', async () => {
  let searches = 0;
  const resolver = new IpGeolocationResolver((ipAddress) => {
    searches += 1;
    assert.equal(ipAddress, '1.2.3.4');
    return {
      country: '中国',
      province: '浙江省',
      city: '杭州市',
      isp: '电信',
    };
  });

  const expected = {
    country: '中国',
    province: '浙江省',
    city: '杭州市',
    isp: '电信',
    displayName: '中国 浙江省 杭州市 电信',
    source: 'ip2region',
  };
  assert.deepEqual(await resolver.resolve('1.2.3.4'), expected);
  assert.deepEqual(await resolver.resolve('1.2.3.4'), expected);
  assert.equal(searches, 1);
});

test('offline IP geolocation skips private, reserved and IPv6 addresses', async () => {
  let searches = 0;
  const resolver = new IpGeolocationResolver(() => {
    searches += 1;
    return null;
  });

  assert.equal(await resolver.resolve('127.0.0.1'), null);
  assert.equal(await resolver.resolve('192.168.1.2'), null);
  assert.equal(await resolver.resolve('203.0.113.10'), null);
  assert.equal(await resolver.resolve('2001:db8::1'), null);
  assert.equal(await resolver.resolve(null), null);
  assert.equal(searches, 0);
});

test('bundled ip2region database resolves a public IPv4 address without external access', async () => {
  const resolver = new IpGeolocationResolver();
  const location = await resolver.resolve('218.4.167.70');
  assert.equal(location?.country, '中国');
  assert.ok(location?.province);
  assert.ok(location?.city);
  assert.equal(location?.source, 'ip2region');
});
