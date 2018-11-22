#!/bin/bash -vex

: KEY_PAIR ${KEY_PAIR=wcosta}

regions='us-east-1 us-east-2 us-west-1 us-west-2 eu-central-1'
declare -A amis=(
    ["useast1"]="ami-0ac019f4fcb7cb7e6"
    ["useast2"]="ami-0f65671a86f061fcd"
    ["uswest1"]="ami-063aa838bd7631e0b"
    ["uswest2"]="ami-0bbe6b35405ecebdb"
    ["eucentral1"]="ami-0bdf93799014acdc4" )

get_instance_state() {
    aws ec2 describe-instances --instance-ids $1 --region $region \
        | jq '.Reservations[0].Instances[0].State.Name' \
        | tr -d -- \"
}

for region in $regions; do
    ami_index=$(echo $region | tr -d -- -)

    instance_id=$(aws ec2 run-instances \
        --region "$region" \
        --image-id "${amis[$ami_index]}" \
        --instance-type 't2.nano' \
        --key-name $KEY_PAIR \
        --security-groups ssh-only \
        --count 1 | jq '.Instances[0].InstanceId' | tr -d -- \")

    while [ $(get_instance_state $instance_id) != "running" ]; do
        sleep 5
    done

    instance_ip=$(aws ec2 describe-instances --instance-ids $instance_id --region $region \
        | jq '.Reservations[0].Instances[0].PublicIpAddress' \
        | tr -d -- \")

    ssh \
        -i ~/.ssh/$KEY_PAIR.pem ubuntu@$instance_ip \
        -oStrictHostKeyChecking=no \
        "curl http://169.254.169.254/latest/dynamic/instance-identity/document" > $region.doc

    ssh \
        -i ~/.ssh/$KEY_PAIR.pem ubuntu@$instance_ip \
        -oStrictHostKeyChecking=no \
        "curl http://169.254.169.254/latest/dynamic/instance-identity/rsa2048" > $region.sig

    aws ec2 terminate-instances --instance-ids $instance_id --region $region
done
