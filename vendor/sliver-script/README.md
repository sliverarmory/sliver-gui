# Sliver Script

Sliver-script is a TypeScript/JavaScript client library for Sliver, it can be used to automate any operator interaction with Sliver. Sliver-script uses existing Sliver client configuration files and connects to servers using gRPC over Mutual-TLS. It also provides [RxJS](https://www.learnrxjs.io/) abstractions for easy interactions with real-time components.

This library targets modern Sliver protobuf/gRPC APIs and provides a strongly-typed TypeScript-first client.

[![Publish](https://github.com/moloch--/sliver-script/actions/workflows/publish.yml/badge.svg)](https://github.com/moloch--/sliver-script/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/sliver-script.svg)](https://www.npmjs.com/package/sliver-script)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

### Install

Node v24 or later is required for this package, and it can be installed via npm:

`npm install sliver-script`


### TypeScript Example

#### Basic

```typescript
import { SliverClient, ParseConfigFile } from 'sliver-script'

(async function() {
    
    const config = await ParseConfigFile('./localhost.cfg')
    const client = new SliverClient(config)

    await client.connect()

    const version = await client.getVersion()
    console.log(version)

    const sessions = await client.sessions()
    console.log(`Sessions: ${sessions.length}`)

    await client.disconnect()

})()
```

#### Monitor Events in Real-time

```typescript
import { SliverClient, ParseConfigFile } from 'sliver-script'

(async function() {

    const config = await ParseConfigFile('./localhost.cfg')

    const client = new SliverClient(config)
    await client.connect()
    client.event$.subscribe((event) => {
        console.log(event)
    })

})()
```

#### Automatically Interact with New Sessions

```typescript
import { SliverClient, ParseConfigFile } from 'sliver-script'


(async function() {

    const config = await ParseConfigFile('./localhost.cfg')
    const client = new SliverClient(config);
    await client.connect()

    console.log('Waiting for new sessions ...')
    client.session$.subscribe(async (event) => {
        console.log(`New session #${event.Session.ID}!`)
        const session = client.interactSession(event.Session.ID)
        const ls = await session.ls('.')
        console.log(`Path: ${ls.Path}`)
        ls.Files.forEach(file => {
            console.log(`Name: ${file.Name} (Size: ${file.Size})`)
        })
    })

})()
```

### JavaScript Example

```javascript
const sliver = require('sliver-script')

(async function() { 

    const config = await sliver.ParseConfigFile('./localhost.cfg')
    const client = new sliver.SliverClient(config)
    await client.connect()

    console.log('Waiting for new sessions ...')

    client.session$.subscribe(async (event) => {

        console.log(`New session #${event.Session.ID}!`)

        const session = client.interactSession(event.Session.ID)
        const ls = await session.ls('.')
        console.log(`Path: ${ls.Path}`)
        ls.Files.forEach(file => {
            console.log(`Name: ${file.Name} (Size: ${file.Size})`)
        })
        
    })

})()
```
