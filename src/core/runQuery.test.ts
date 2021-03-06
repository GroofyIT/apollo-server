import { expect } from 'chai';
import { stub } from 'sinon';

import {
    GraphQLSchema,
    GraphQLObjectType,
    GraphQLString,
    GraphQLInt,
    GraphQLNonNull,
    parse,
} from 'graphql';

import {
  runQuery,
  LogAction,
  LogStep,
} from './runQuery';

// Make the global Promise constructor Fiber-aware to simulate a Meteor
// environment.
import { makeCompatible } from 'meteor-promise';
import Fiber = require('fibers');
makeCompatible(Promise, Fiber);

const QueryType = new GraphQLObjectType({
    name: 'QueryType',
    fields: {
        testString: {
            type: GraphQLString,
            resolve() {
                return 'it works';
            },
        },
        testRootValue: {
            type: GraphQLString,
            resolve(root) {
                return root + ' works';
            },
        },
        testContextValue: {
            type: GraphQLString,
            resolve(root, args, context) {
                return context + ' works';
            },
        },
        testArgumentValue: {
            type: GraphQLInt,
            resolve(root, args, context) {
                return args['base'] + 5;
            },
            args: {
                base: { type: new GraphQLNonNull(GraphQLInt) },
            },
        },
        testAwaitedValue: {
            type: GraphQLString,
            resolve(root) {
                // Calling Promise.await is legal here even though this is
                // not an async function, because we are guaranteed to be
                // running in a Fiber.
                return 'it ' + (<any>Promise).await('works');
            },
        },
        testError: {
            type: GraphQLString,
            resolve() {
                throw new Error('Secret error message');
            },
        },
    },
});

const Schema = new GraphQLSchema({
    query: QueryType,
});

describe('runQuery', () => {
  it('returns the right result when query is a string', () => {
      const query = `{ testString }`;
      const expected = { testString: 'it works' };
      return runQuery({ schema: Schema, query: query })
      .then((res) => {
          return expect(res.data).to.deep.equal(expected);
      });
  });

  it('returns the right result when query is a document', () => {
      const query = parse(`{ testString }`);
      const expected = { testString: 'it works' };
      return runQuery({ schema: Schema, query: query })
      .then((res) => {
          return expect(res.data).to.deep.equal(expected);
      });
  });

  it('returns a syntax error if the query string contains one', () => {
    const query = `query { test `;
    const expected = /Syntax Error GraphQL/;
    return runQuery({
        schema: Schema,
        query: query,
        variables: { base: 1 },
    }).then((res) => {
        expect(res.data).to.be.undefined;
        expect(res.errors.length).to.equal(1);
        return expect(res.errors[0].message).to.match(expected);
    });
  });

  it('sends stack trace to error if in an error occurs and debug mode is set', () => {
    const query = `query { testError }`;
    const expected = /at resolveOrError/;
    const logStub = stub(console, 'error');
    return runQuery({
        schema: Schema,
        query: query,
        debug: true,
    }).then((res) => {
        logStub.restore();
        expect(logStub.callCount).to.equal(1);
        return expect(logStub.getCall(0).args[0]).to.match(expected);
    });
  });

  it('does not send stack trace if in an error occurs and not in debug mode', () => {
    const query = `query { testError }`;
    const logStub = stub(console, 'error');
    return runQuery({
        schema: Schema,
        query: query,
        debug: false,
    }).then((res) => {
        logStub.restore();
        return expect(logStub.callCount).to.equal(0);
    });
  });

  it('returns a validation error if the query string does not pass validation', () => {
      const query = `query TestVar($base: String){ testArgumentValue(base: $base) }`;
      const expected = 'Variable "$base" of type "String" used in position expecting type "Int!".';
      return runQuery({
          schema: Schema,
          query: query,
          variables: { base: 1 },
      }).then((res) => {
          expect(res.data).to.be.undefined;
          expect(res.errors.length).to.equal(1);
          return expect(res.errors[0].message).to.deep.equal(expected);
      });
  });

  it('does not run validation if the query is a document', () => {
      // this would not pass validation, because $base ought to be Int!, not String
      // what effecively happens is string concatentation, but it's returned as Int
      const query = parse(`query TestVar($base: String){ testArgumentValue(base: $base) }`);
      const expected = { testArgumentValue: 15 };
      return runQuery({
          schema: Schema,
          query: query,
          variables: { base: 1 },
      }).then((res) => {
          return expect(res.data).to.deep.equal(expected);
      });
  });

  it('correctly passes in the rootValue', () => {
      const query = `{ testRootValue }`;
      const expected = { testRootValue: 'it also works' };
      return runQuery({ schema: Schema, query: query, rootValue: 'it also' })
      .then((res) => {
          return expect(res.data).to.deep.equal(expected);
      });
  });

  it('correctly passes in the context', () => {
      const query = `{ testContextValue }`;
      const expected = { testContextValue: 'it still works' };
      return runQuery({ schema: Schema, query: query, context: 'it still' })
      .then((res) => {
          return expect(res.data).to.deep.equal(expected);
      });
  });

  it('passes the options to formatResponse', () => {
      const query = `{ testContextValue }`;
      const expected = { testContextValue: 'it still works' };
      return runQuery({
          schema: Schema,
          query: query,
          context: 'it still',
          formatResponse: (response, { context }) => {
              response['extensions'] = context;
              return response;
          },
        })
      .then((res) => {
          expect(res.data).to.deep.equal(expected);
          return expect(res['extensions']).to.equal('it still');
      });
  });

  it('correctly passes in variables (and arguments)', () => {
      const query = `query TestVar($base: Int!){ testArgumentValue(base: $base) }`;
      const expected = { testArgumentValue: 6 };
      return runQuery({
          schema: Schema,
          query: query,
          variables: { base: 1 },
      }).then((res) => {
          return expect(res.data).to.deep.equal(expected);
      });
  });

  it('throws an error if there are missing variables', () => {
      const query = `query TestVar($base: Int!){ testArgumentValue(base: $base) }`;
      const expected = 'Variable "$base" of required type "Int!" was not provided.';
      return runQuery({
          schema: Schema,
          query: query,
      }).then((res) => {
          return expect(res.errors[0].message).to.deep.equal(expected);
      });
  });

    it('supports yielding resolver functions', () => {
        return runQuery({
            schema: Schema,
            query: `{ testAwaitedValue }`,
        }).then((res) => {
            expect(res.data).to.deep.equal({
                testAwaitedValue: 'it works',
            });
        });
    });

    it('runs the correct operation when operationName is specified', () => {
        const query = `
        query Q1 {
            testString
        }
        query Q2 {
            testRootValue
        }`;
        const expected = {
            testString: 'it works',
        };
        return runQuery({ schema: Schema, query: query, operationName: 'Q1' })
        .then((res) => {
            return expect(res.data).to.deep.equal(expected);
        });
    });

    it('calls logFunction', () => {
        const query = `
        query Q1 {
            testString
        }`;
        const logs = [];
        const logFn = (obj) => logs.push(obj);
        const expected = {
            testString: 'it works',
        };
        return runQuery({
            schema: Schema,
            query: query,
            operationName: 'Q1',
            variables: { test: 123 },
            logFunction: logFn,
        })
        .then((res) => {
            expect(res.data).to.deep.equal(expected);
            expect(logs.length).to.equals(11);
            expect(logs[0]).to.deep.equals({action: LogAction.request, step: LogStep.start});
            expect(logs[1]).to.deep.equals({action: LogAction.request, step: LogStep.status, key: 'query', data: query});
            expect(logs[2]).to.deep.equals({action: LogAction.request, step: LogStep.status, key: 'variables', data: { test: 123 }});
            expect(logs[3]).to.deep.equals({action: LogAction.request, step: LogStep.status, key: 'operationName', data: 'Q1'});
            expect(logs[10]).to.deep.equals({action: LogAction.request, step: LogStep.end});
        });
    });
});
