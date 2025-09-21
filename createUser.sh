set -euo pipefail

echo "Loading..."
sleep 1
echo "."
sleep 1
echo ".."
sleep 1
echo "..."
sleep 1
clear
echo "Creating user..."

while true; do
  read -rp "Enter username: " username
  if [[ -z "${username// /}" ]]; then
    echo "Username cannot be empty. Please try again."
    continue
  fi
  
  if [[ "$username" == *"/"* || "$username" == *".."* ]]; then
    echo "Username cannot contain '/' or '..'."
    continue
  fi
  userfile="users/${username}.json"
  if [[ -e "$userfile" ]]; then
    read -rp "User ${username} already exists. Overwrite? (y/n): " yn
    case "${yn,,}" in
      y|yes) break ;;
      n|no) echo "Please enter a different username."; continue ;;
      *) echo "Please answer y or n."; continue ;;
    esac
  else
    break
  fi
done

while true; do
  read -rp "Enter email: " email
  if [[ -z "${email// /}" ]]; then
    echo "Email cannot be empty. Please try again."
    continue
  fi
  
  if [[ "$email" != *@*.* ]]; then
    echo "Email format looks invalid. Please enter a valid email."
    continue
  fi
  break
done

while true; do
  read -rsp "Enter password: " password
  echo
  if [[ -z "$password" ]]; then
    echo "Password cannot be empty. Please try again."
    continue
  fi
  read -rsp "Confirm password: " password2
  echo
  if [[ "$password" != "$password2" ]]; then
    echo "Passwords do not match. Try again."
    continue
  fi
  break
done

while true; do
  read -rp "Enter admin (true/false): " admin
  admin_lower="${admin,,}"
  if [[ "$admin_lower" == "true" || "$admin_lower" == "false" ]]; then
    admin="$admin_lower"
    break
  fi
  echo "Admin must be either 'true' or 'false'. Please try again."
done

cat > "$userfile" <<EOF
{
  "username": "${username}",
  "email": "${email}",
  "password": "${password}",
  "admin": ${admin}
}
EOF

echo "Done creating user ${username}"
echo "Waiting for 5 seconds..."
sleep 5
clear