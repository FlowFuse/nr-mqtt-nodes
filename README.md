# FlowFuse MQTT Nodes

A set of Node-RED nodes that work seamlessly with the FlowFuse MQTT Broker
running in the [FlowFuse platform](https://flowfuse.com).

These nodes act in a similar way to the core Node-RED MQTT nodes without any
broker configuration required to get up and running.

Whilst these nodes are published under the Apache-2.0 license, they can only be
used with an instance of the FlowFuse platform with an active EE license applied.
If you try to install these nodes in an Non FlowFuse EE platform you will see the following error in your Node-RED log:
`Error: Project Link nodes cannot be loaded outside of FlowFuse EE environment`
This can be safely ignored.

### Prerequisites

 - FlowFuse 2.21.0 running with an active EE license and its integrated MQTT Broker

Alternatively, you can [sign up to FlowFuse Cloud](https://flowfuse.com/product/)
now to try these nodes out.

### Nodes

There are three nodes in this collection:

 - `FF MQTT In` - subscribes to topics on the FlowFuse MQTT Broker
 - `FF MQTT Out` - publishes messages to the FlowFuse MQTT Broker

For further usage details, please refer to the individual node's built-in documentation.
