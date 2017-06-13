const testing = require('taskcluster-lib-testing');
const taskcluster = require('taskcluster-client');
const assume = require('assume');
const main = require('../lib/main');
const {api} = require('../lib/api');
const sinon = require('sinon');

describe('Api', () => {
  let state;
  let region = 'us-west-2';
  let instanceType = 'c3.xlarge';
  let workerType = 'apiTest';
  let client;
  let server;
  let sandbox = sinon.sandbox.create();
  let runaws;

  before(async () => {
    // We want a clean DB state to verify things happen as we intend
    state = await main('state', {profile: 'test', process: 'test'});

    testing.fakeauth.start({
      hasauth: ['ec2-manager:import-spot-request']
    });

    let apiRef = api.reference({baseUrl: 'http://localhost:5555/v1'});
    let EC2Manager = taskcluster.createClient(apiRef);

    client = new EC2Manager({
      credentials: {
        clientId: 'hasauth',
        accessToken: 'abcde',
      }
    });
  });

  beforeEach(async () => {
    await state._runScript('clear-db.sql');
    runaws = sandbox.stub();
    server = await main('server', {profile: 'test', process: 'test', runaws});
  });

  afterEach(() => {
    testing.fakeauth.stop();
    server.terminate();
    sandbox.restore();
  });

  it('api comes up', async () => {
    let result = await client.ping();
    assume(result).has.property('alive', true);
  });

  describe.only('managing resources', () => {
    beforeEach(async () => {
      let status = 'pending-fulfillment';
      await state.insertInstance({id: 'i-1', workerType, region: 'us-east-1', instanceType, state: 'running'});
      await state.insertInstance({id: 'i-2', workerType, region: 'us-west-1', instanceType, state: 'running'});
      await state.insertInstance({id: 'i-3', workerType, region: 'us-west-2', instanceType, state: 'pending', srid: 'r-3'});
      // Insert some spot requests
      await state.insertSpotRequest({id: 'r-1', workerType, region: 'us-east-1', instanceType, state: 'open', status});
      await state.insertSpotRequest({id: 'r-2', workerType, region: 'us-west-1', instanceType, state: 'open', status});
    });

    it('should be able to kill all of a worker type', async () => {
      let result = await client.killAllWorkertype(workerType); 

      // Lengthof doesn't seem to work here.  oh well
      assume(runaws.args).has.property('length', 6);
      for (let call of runaws.args) {
        let region = call[0].config.region;
        let endpoint = call[1];
        let obj = call[2];

        if (endpoint === 'cancelSpotInstanceRequests') {
          if (region === 'us-east-1') {
            assume(obj.SpotInstanceRequestIds).deeply.equals(['r-1']);
          } else if (region === 'us-west-1') {
            assume(obj.SpotInstanceRequestIds).deeply.equals(['r-2']);
          } else if (region === 'us-west-2') {
            assume(obj.SpotInstanceRequestIds).deeply.equals(['r-3']);
          }
        } else if (endpoint === 'terminateInstances') {
            if (region === 'us-east-1') {
              assume(obj.InstanceIds).deeply.equals(['i-1']);
            } else if (region === 'us-west-1') {
              assume(obj.InstanceIds).deeply.equals(['i-2']);
            } else if (region === 'us-west-2') {
              assume(obj.InstanceIds).deeply.equals(['i-3']);
            }
        }
      }
    });

  });

  describe('importing spot requests', () => {
    const sr = {
      SpotInstanceRequests: [{
        SpotInstanceRequestId: 'r-12345',
        LaunchSpecification: {
          KeyName: 'testing:workertype:hash',
          InstanceType: instanceType,

        },
        State: 'open',
        Status: {
          Code: 'pending-fulfillment',
        }
      }]
    }

    it('should import a spot request', async () => {
      let requests = await state.listSpotRequests();
      assume(requests).lengthOf(0);
      await client.importSpotRequest(region, sr);
      requests = await state.listSpotRequests();
      assume(requests).lengthOf(1);
    });

    it('should fail if trying to reinsert existing request', async () => {
      let requests = await state.listSpotRequests();
      assume(requests).lengthOf(0);
      await client.importSpotRequest(region, sr);
      try {
        await client.importSpotRequest(region, sr);
        return Promise.reject(new Error('should fail!'));
      } catch (err) {
        assume(err).has.property('code', 'RequestConflict');
        assume(err).has.property('statusCode', 409);
      }
      requests = await state.listSpotRequests();
      assume(requests).lengthOf(1);
    });
  });

  // These are functions which are supposed to be used for debugging and
  // troubleshooting primarily.  Maybe some ui stuff?
  describe('internal api', () => {
    it('should list regions', async () => {
      let result = await client.regions();
      result.regions.sort();
      assume(result.regions).deeply.equals([
        'us-east-1',
        'us-east-2',
        'us-west-1',
        'us-west-2',
        'eu-central-1',
      ].sort());
    });

    it('should list spot requests to poll', async () => {
      await state.insertSpotRequest({
        workerType: 'abcd',
        region,
        instanceType,
        id: 'r-1234',
        state: 'open',
        status: 'pending-fulfillment',
      });
      let result = await client.spotRequestsToPoll();
      assume(result).has.lengthOf(5);
      let usw2 = result.filter(x => x.region === 'us-west-2')[0];
      assume(usw2.values).has.lengthOf(1);
      assume(usw2.values[0]).equals('r-1234');
    });
  });
});
