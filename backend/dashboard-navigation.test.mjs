import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardView} from '../public/dashboard.js';

test('dashboard accepts current screens and old deep links, with overview as the fallback',()=>{
  for(const view of ['overview','plan','fleet','haul','orders','registries'])assert.equal(dashboardView(view),view);
  for(const [hash,view] of [['shift-map','overview'],['shift-settings','plan'],['shift-details','plan'],['registry','registries'],
    ['unknown','overview'],['toString','overview'],['','overview']])assert.equal(dashboardView(hash),view);
});
